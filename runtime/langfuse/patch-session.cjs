"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const { Script } = require("node:vm");
const sharedSession = require("./shared-session.cjs");
const upstream = require("./upstream.json");

const file = process.argv[2] ?? upstream.file;
const source = readFileSync(file, "utf8");
assert.equal(createHash("sha256").update(source).digest("hex"), upstream.sha256);
const { name, start, end } = upstream.function;
assert.match(name, /^[a-zA-Z_$][\w$]*$/);
assert.ok(source.slice(start, end).startsWith(`async function ${name}(`));
assert.ok(source.slice(start, end).includes("JWT_SESSION_ERROR"));
const replacement = sharedSession.toString().replace("function sharedSession", `function ${name}`);
const patched = source.slice(0, start) + replacement + source.slice(end);
new Script(patched, { filename: file });
writeFileSync(file, patched);
console.log("Installed Langfuse shared web session");
