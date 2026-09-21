import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { complete } from "../src/stream.ts";
import type { Context, Model } from "../src/types.ts";

const servers: Server[] = [];

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
				}),
		),
	);
});

function listen(handler: (body: string, respond: (status: number, contentType: string, payload: string) => void, reqClose: () => void) => void): Promise<{ server: Server; port: number; posts: () => number }> {
	let posts = 0;
	const server = createServer((req, res) => {
		posts += 1;
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			handler(
				body,
				(status, contentType, payload) => {
					res.writeHead(status, { "content-type": contentType });
					res.end(payload);
				},
				() => {
					res.destroy();
				},
			);
		});
		req.on("close", () => {
			if (!res.writableEnded) res.destroy();
		});
	});
	servers.push(server);
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve({ server, port: (server.address() as AddressInfo).port, posts: () => posts });
		});
	});
}

function model(port: number, provider = "llama-cpp"): Model<"openai-completions"> {
	return {
		id: "blaskgpt",
		name: "blaskgpt",
		api: "openai-completions",
		provider,
		baseUrl: `http://127.0.0.1:${port}/v1`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 32000,
	};
}

function context(): Context {
	return { messages: [{ role: "user", content: "ping", timestamp: Date.now() }] };
}

const textCompletion = JSON.stringify({
	id: "chatcmpl-text",
	object: "chat.completion",
	model: "blaskgpt",
	choices: [
		{
			index: 0,
			message: { role: "assistant", content: "pong" },
			finish_reason: "stop",
		},
	],
	usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 9 },
});

const toolCompletion = JSON.stringify({
	id: "chatcmpl-tool",
	object: "chat.completion",
	model: "blaskgpt",
	choices: [
		{
			index: 0,
			message: {
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "read", arguments: "{\"path\":\"a\"}" },
					},
				],
			},
			finish_reason: "tool_calls",
		},
	],
	usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
});

describe("llama-cpp buffered chat completion", () => {
	it("maps a JSON chat.completion requested with stream true", async () => {
		let sawStream = false;
		const { port, posts } = await listen((body, respond) => {
			sawStream = JSON.parse(body).stream === true;
			respond(200, "application/json", textCompletion);
		});
		const message = await complete(model(port), context(), { apiKey: "local-acceptance" });
		expect(sawStream).toBe(true);
		expect(posts()).toBe(1);
		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([expect.objectContaining({ type: "text", text: "pong" })]);
		expect(message.usage.input).toBe(7);
		expect(message.usage.output).toBe(1);
		expect(message.errorMessage).toBeUndefined();
	});

	it("maps null text and structured tool calls without inventing either", async () => {
		const { port, posts } = await listen((_body, respond) => {
			respond(200, "application/json; charset=utf-8", toolCompletion);
		});
		const message = await complete(model(port), context(), { apiKey: "local-acceptance" });
		expect(posts()).toBe(1);
		expect(message.stopReason).toBe("toolUse");
		expect(message.content.some((block) => block.type === "text")).toBe(false);
		expect(message.content).toEqual([
			expect.objectContaining({
				type: "toolCall",
				id: "call_1",
				name: "read",
				arguments: { path: "a" },
			}),
		]);
		expect(message.usage.input).toBe(11);
		expect(message.usage.output).toBe(4);
	});

	it("keeps normal SSE text and tool calls", async () => {
		const sse = [
			'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"pong"}}]}',
			"",
			'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_sse","function":{"name":"read","arguments":"{\\"path\\":\\"b\\"}"}}]}}]}',
			"",
			'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
			"",
			"data: [DONE]",
			"",
		].join("\n");
		const { port, posts } = await listen((_body, respond) => {
			respond(200, "text/event-stream", sse);
		});
		const message = await complete(model(port), context(), { apiKey: "local-acceptance" });
		expect(posts()).toBe(1);
		expect(message.stopReason).toBe("toolUse");
		expect(message.content).toEqual([
			expect.objectContaining({ type: "text", text: "pong" }),
			expect.objectContaining({ type: "toolCall", id: "call_sse", name: "read", arguments: { path: "b" } }),
		]);
		expect(message.usage.input).toBe(3);
		expect(message.usage.output).toBe(2);
	});

	it("rejects a malformed JSON completion without a second request", async () => {
		const { port, posts } = await listen((_body, respond) => {
			respond(200, "application/json", "{");
		});
		const message = await complete(model(port), context(), { apiKey: "local-acceptance" });
		expect(posts()).toBe(1);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("Buffered completion rejected");
		expect(message.content).toEqual([]);
	});

	it("rejects a completion that omits finish_reason", async () => {
		const body = JSON.stringify({
			object: "chat.completion",
			choices: [{ index: 0, message: { role: "assistant", content: "pong" } }],
		});
		const { port, posts } = await listen((_body, respond) => {
			respond(200, "application/json", body);
		});
		const message = await complete(model(port), context(), { apiKey: "local-acceptance" });
		expect(posts()).toBe(1);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("missing finish_reason");
		expect(message.usage.output).toBe(0);
	});

	it("does not translate buffered JSON for a provider that did not opt in", async () => {
		const { port, posts } = await listen((_body, respond) => {
			respond(200, "application/json", textCompletion);
		});
		const message = await complete(model(port, "openai"), context(), { apiKey: "local-acceptance", maxRetries: 0 });
		expect(posts()).toBe(1);
		expect(message.stopReason).not.toBe("stop");
		expect(message.content.some((block) => block.type === "text" && block.text === "pong")).toBe(false);
	});

	it("aborts before a buffered body arrives and does not leave a second request", async () => {
		let posts = 0;
		let closed = 0;
		let markArrived: () => void = () => {};
		const arrived = new Promise<void>((resolve) => {
			markArrived = resolve;
		});
		const server = createServer((req, res) => {
			posts += 1;
			markArrived();
			req.on("close", () => {
				closed += 1;
				res.destroy();
			});
		});
		servers.push(server);
		const port = await new Promise<number>((resolve) => {
			server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
		});
		const controller = new AbortController();
		const pending = complete(model(port), context(), { apiKey: "local-acceptance", signal: controller.signal });
		await arrived;
		controller.abort();
		const message = await pending;
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(message.stopReason).toBe("aborted");
		expect(posts).toBe(1);
		expect(closed).toBe(1);
	});
});
