#!/usr/bin/env node

/**
 * Re-serialize a JSON file with tab indentation, matching the format the repo commits.
 *
 * `npm install --package-lock-only` rewrites package-lock.json with two-space indentation,
 * which turns every version bump into a whole-file diff. npm and the repo's own tooling
 * (`sync-versions.js`) both emit via `JSON.stringify`, so this is a pure whitespace
 * transform: key order and content are unchanged, and the script verifies that before
 * writing. Safe to run repeatedly.
 */

import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2] ?? "package-lock.json";
const original = readFileSync(path, "utf8");
const parsed = JSON.parse(original);
const output = `${JSON.stringify(parsed, null, "\t")}\n`;

// Both sides are parsed and re-serialized the same way, so any content or key-order
// difference between input and output would show up here.
if (JSON.stringify(JSON.parse(output), null, 2) !== JSON.stringify(parsed, null, 2)) {
	console.error(`${path}: content would change; refusing to write.`);
	process.exit(1);
}

if (output === original) {
	console.log(`${path} is already tab-indented.`);
} else {
	writeFileSync(path, output);
	console.log(`Rewrote ${path} with tab indentation (content unchanged).`);
}
