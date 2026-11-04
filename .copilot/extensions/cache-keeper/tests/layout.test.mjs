import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LIB = join(ROOT, "lib");
const MODULES = ["contracts", "commands", "config", "tracker", "policy", "transport", "rescue", "unblock", "keeper"];
const PURE_MODULES = ["contracts.mjs", "commands.mjs", "tracker.mjs", "policy.mjs"];
const STATUS_LINE_MODULES = ["config.mjs", "statusline-render.mjs"];
const read = (file) => readFileSync(file, "utf8");
const libFiles = () => (existsSync(LIB) ? readdirSync(LIB).filter((f) => f.endsWith(".mjs")) : []);
const imports = (src) => [...src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1] ?? m[2]);

test("AC-1: keeper-core.mjs is gone and the lib modules exist", () => {
    assert.equal(existsSync(join(ROOT, "keeper-core.mjs")), false);
    for (const m of MODULES) assert.equal(existsSync(join(LIB, `${m}.mjs`)), true, `lib/${m}.mjs`);
});

test("layout: every lib module is listed in MODULES (statusline-render.mjs is the status line's own)", () => {
    const listed = MODULES.map((m) => `${m}.mjs`).sort();
    assert.deepEqual(libFiles().filter((f) => f !== "statusline-render.mjs").sort(), listed);
});

test("AC-1: only lib/transport.mjs touches the session (session.send / session.rpc); the new modules never do", () => {
    const offenders = libFiles().filter((f) => f !== "transport.mjs" && /\bsession\s*\??\.\s*(send|rpc)\b/.test(read(join(LIB, f))));
    assert.deepEqual(offenders, []);
    assert.match(read(join(LIB, "transport.mjs")), /\bsession\.rpc\b/);
    for (const f of ["unblock.mjs", "rescue.mjs"]) assert.equal(/\bsession\b/.test(read(join(LIB, f)).replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")), false, `${f} must not use a session object`);
});

test("AC-1: contracts, commands, tracker and policy import no node: module and no SDK module", () => {
    for (const f of PURE_MODULES) {
        const bad = imports(read(join(LIB, f))).filter((s) => s.startsWith("node:") || s.startsWith("@github/") || !s.startsWith("."));
        assert.deepEqual(bad, [], f);
    }
});

test("AC-1: only extension.mjs imports @github/copilot-sdk", () => {
    const files = [...readdirSync(ROOT).filter((f) => f.endsWith(".mjs")).map((f) => join(ROOT, f)), ...libFiles().map((f) => join(LIB, f))];
    const importers = files.filter((f) => imports(read(f)).some((s) => s.startsWith("@github/copilot-sdk"))).map((f) => f.slice(ROOT.length).replaceAll("\\", "/"));
    assert.deepEqual(importers, ["extension.mjs"]);
});

test("B1 AC-12: config.mjs and statusline-render.mjs import no node: or SDK module (statusline.mjs loads them on every refresh)", () => {
    for (const f of STATUS_LINE_MODULES) {
        const bad = imports(read(join(LIB, f))).filter((s) => s.startsWith("node:") || s.startsWith("@github/") || !s.startsWith("."));
        assert.deepEqual(bad, [], f);
    }
});
