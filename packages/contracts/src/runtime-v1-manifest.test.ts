// Project/App: gsd-pi
// File Purpose: Verify copied C01 runtime-v1 contracts against the producer manifest.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const runtimeV1Root = fileURLToPath(new URL("../runtime-v1/", import.meta.url));
const manifestPath = join(runtimeV1Root, "manifest.json");
const expectedSchemaSha256 = "0643f017003901c73859db55ae74dbc0bb67b270e43554a7111ca8038d8aca01";

type ManifestEntry = { path: string; sha256: string };

type Manifest = {
	pack_version: string;
	schema: { path: string; sha256: string; id: string };
	examples: ManifestEntry[];
	fixtures: ManifestEntry[];
	monitor_v3: ManifestEntry[];
};

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function listFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) walk(full);
			else out.push(relative(root, full).split("\\").join("/"));
		}
	};
	walk(root);
	return out.sort();
}

test("C01 runtime-v1 manifest hashes match copied files", () => {
	assert.equal(existsSync(manifestPath), true, "producer manifest must be copied");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;
	assert.equal(manifest.pack_version, "1.0.0");
	assert.equal(manifest.schema.sha256, expectedSchemaSha256);
	assert.equal(sha256File(join(runtimeV1Root, manifest.schema.path)), expectedSchemaSha256);

	const listed = [
		manifest.schema.path,
		...manifest.examples.map((entry) => entry.path),
		...manifest.fixtures.map((entry) => entry.path),
		...manifest.monitor_v3.map((entry) => entry.path),
	];
	const expected = new Map<string, string>();
	expected.set(manifest.schema.path, manifest.schema.sha256);
	for (const entry of [...manifest.examples, ...manifest.fixtures, ...manifest.monitor_v3]) {
		expected.set(entry.path, entry.sha256);
	}

	for (const [path, digest] of expected) {
		const full = join(runtimeV1Root, path);
		assert.equal(existsSync(full), true, `missing copied contract file: ${path}`);
		assert.equal(sha256File(full), digest, `digest mismatch for ${path}`);
	}

	const onDisk = listFiles(runtimeV1Root).filter((path) => path !== "manifest.json" && path !== "PRODUCER.md");
	for (const path of onDisk) {
		assert.equal(expected.has(path), true, `competing or unlisted contract file: ${path}`);
	}
	assert.deepEqual([...expected.keys()].sort(), listed.sort());
});

test("producer reference documents C01 as the schema owner", () => {
	const producer = readFileSync(join(dirname(manifestPath), "PRODUCER.md"), "utf-8");
	assert.match(producer, /C01/);
	assert.match(producer, /raid-night\/docs\/migration\/pack\/contracts/);
	assert.match(producer, new RegExp(expectedSchemaSha256));
});
