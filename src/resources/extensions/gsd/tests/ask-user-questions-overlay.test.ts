// ask-user-questions-overlay — Regression tests for #2333
//
// While the interview dialog is displayed the chat viewport bounced up/down:
// the dialog REPLACED the editor in the bottom-anchored layout, so every
// mount/unmount shrank/grew the bottom block and triggered destructive
// full repaints. The interview must be requested as an overlay instead.

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import askUserQuestionsExtension, {
	resetAskUserQuestionsCache,
	resolvePendingBridgeModule,
} from "../../ask-user-questions.ts";

const gsdRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");

const question = {
	id: "depth_check",
	header: "Depth Check",
	question: "Did I capture the depth right?",
	options: [
		{ label: "Yes, you got it", description: "Proceed" },
		{ label: "Not quite - let me clarify", description: "Clarify" },
	],
};

function getAskUserQuestionsTool() {
	const tools: any[] = [];
	askUserQuestionsExtension({ registerTool: (tool: any) => tools.push(tool) } as any);
	const tool = tools.find((t) => t.name === "ask_user_questions");
	assert.ok(tool, "ask_user_questions should be registered");
	return tool;
}

function fakeCtx(customCalls: unknown[]) {
	return {
		hasUI: true,
		ui: {
			custom: (_factory: unknown, options?: unknown) => {
				customCalls.push(options);
				return Promise.resolve({
					endInterview: false,
					answers: { depth_check: { selected: "Yes, you got it", notes: "" } },
				});
			},
		},
	} as any;
}

describe("ask_user_questions interview overlay (#2333)", () => {
	beforeEach(() => {
		resetAskUserQuestionsCache();
		// Keep the local-only path deterministic regardless of machine prefs.
		process.env.GSD_DISABLE_REMOTE_QUESTIONS = "1";
	});

	afterEach(() => {
		delete process.env.GSD_DISABLE_REMOTE_QUESTIONS;
	});

	test("local-only path requests the interview as an overlay", async () => {
		const tool = getAskUserQuestionsTool();
		const customCalls: unknown[] = [];
		const ctx = fakeCtx(customCalls);

		const result = await tool.execute("t1", { questions: [question] }, undefined, () => {}, ctx);

		assert.equal(customCalls.length, 1, "interview should be dispatched through ui.custom");
		assert.deepEqual(customCalls[0], { overlay: true });
		assert.equal((result.details as any).cancelled, false);
	});

	test("GSD_WEB_DAEMON_MODE uses packaged pending-input even when hasUI is true", async () => {
		const root = mkdtempSync(join(tmpdir(), "c15l-ask-daemon-"));
		const previousDaemon = process.env.GSD_WEB_DAEMON_MODE;
		const previousState = process.env.GSD_STATE_DIR;
		process.env.GSD_WEB_DAEMON_MODE = "1";
		process.env.GSD_STATE_DIR = root;
		mkdirSync(join(root, "runtime-control"), { recursive: true });
		writeFileSync(
			join(root, "runtime-control", "lease.json"),
			`${JSON.stringify({ lease: { job_id: "c14:M001" } })}\n`,
		);
		let selectCalled = 0;
		let customCalled = 0;
		const tool = getAskUserQuestionsTool();
		const ctx = {
			hasUI: true,
			ui: {
				mode: "rpc",
				custom: async () => {
					customCalled += 1;
					return undefined;
				},
				select: async () => {
					selectCalled += 1;
					return new Promise(() => {});
				},
			},
		};
		try {
			const pendingPath = join(root, "runtime-control", "pending-questions.json");
			const running = tool.execute("t-daemon", { questions: [question] }, undefined, () => {}, ctx);
			const deadline = Date.now() + 2000;
			while (Date.now() < deadline) {
				try {
					readFileSync(pendingPath, "utf-8");
					break;
				} catch {
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
			}
			const pending = JSON.parse(readFileSync(pendingPath, "utf-8")) as {
				questions?: Array<{ question_id: string; job_id: string; session_id: string }>;
			};
			assert.equal(pending.questions?.[0]?.question_id, question.id);
			assert.equal(pending.questions?.[0]?.job_id, "c14:M001");
			assert.equal(pending.questions?.[0]?.session_id, "daemon:c14:M001");
			assert.equal(selectCalled, 0);
			assert.equal(customCalled, 0);
			mkdirSync(join(root, "runtime-control", "daemon-answers"), { recursive: true });
			writeFileSync(
				join(root, "runtime-control", "daemon-answers", `${question.id}.json`),
				`${JSON.stringify({
					question_id: question.id,
					job_id: "c14:M001",
					response: { [question.id]: "Yes, you got it" },
					answered_at: new Date().toISOString(),
				})}\n`,
			);
			const result = await running;
			assert.equal((result.details as { cancelled?: boolean }).cancelled, false);
			assert.match(String(result.content?.[0]?.text ?? ""), /Yes, you got it/);
		} finally {
			if (previousDaemon === undefined) delete process.env.GSD_WEB_DAEMON_MODE;
			else process.env.GSD_WEB_DAEMON_MODE = previousDaemon;
			if (previousState === undefined) delete process.env.GSD_STATE_DIR;
			else process.env.GSD_STATE_DIR = previousState;
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("pending-bridge resolves via GSD_WEB_PACKAGE_ROOT when the extension is copied away from src/resources", () => {
		const copiedHere = mkdtempSync(join(tmpdir(), "c15l-pending-bridge-"));
		const previous = process.env.GSD_WEB_PACKAGE_ROOT;
		try {
			delete process.env.GSD_WEB_PACKAGE_ROOT;
			assert.throws(
				() => resolvePendingBridgeModule(copiedHere),
				/GSD_WEB_PACKAGE_ROOT/,
			);
			process.env.GSD_WEB_PACKAGE_ROOT = gsdRoot;
			const resolved = resolvePendingBridgeModule(copiedHere);
			assert.match(resolved, /runtime-control\/pending-bridge\.ts$/);
			assert.ok(resolved.startsWith(gsdRoot));
		} finally {
			if (previous === undefined) delete process.env.GSD_WEB_PACKAGE_ROOT;
			else process.env.GSD_WEB_PACKAGE_ROOT = previous;
			rmSync(copiedHere, { recursive: true, force: true });
		}
	});
});
