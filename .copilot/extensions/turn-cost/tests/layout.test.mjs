// Layout guards of the turn-cost extension: the lib contents, the only session access, the SDK import, no console or model output, the config keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { METRICS, DEFAULT_METRICS } from "../lib/contracts.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LIB = join(ROOT, "lib");
const SELF = fileURLToPath(import.meta.url);
const LIB_MODULES = ["accounting", "color", "config", "contracts", "format", "intervals", "render", "reporter", "transport"];

const read = (file) => readFileSync(file, "utf8");
const libFiles = () => readdirSync(LIB).filter((f) => f.endsWith(".mjs")).sort();
const imports = (src) => [...src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1] ?? m[2]);

/** Source without comments and string literals: what the code does, not what its comments or messages say. */
function codeOnly(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1")
        .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
}

/** Every .mjs file of the extension except logs and this test. */
function extensionModules() {
    return readdirSync(ROOT, { recursive: true })
        .map((p) => String(p))
        .filter((p) => p.endsWith(".mjs") && !p.startsWith("logs" + sep) && join(ROOT, p) !== SELF)
        .map((p) => join(ROOT, p));
}

test("lib holds exactly accounting, color, config, contracts, format, intervals, render, reporter, transport", () => {
    assert.deepEqual(libFiles(), LIB_MODULES.map((m) => `${m}.mjs`));
});

test("only transport.mjs calls session.log and no other lib file mentions session", () => {
    for (const file of libFiles().filter((f) => f !== "transport.mjs")) {
        assert.doesNotMatch(codeOnly(read(join(LIB, file))), /\bsession\b/, file);
    }
    assert.match(codeOnly(read(join(LIB, "transport.mjs"))), /\bsession\.log\(/);
});

test("no lib module imports node: or the SDK", () => {
    for (const file of libFiles()) {
        const bad = imports(read(join(LIB, file))).filter((s) => s.startsWith("node:") || s.startsWith("@github/"));
        assert.deepEqual(bad, [], file);
    }
});

test("only extension.mjs imports @github/copilot-sdk, and wiring.mjs joins with joinSession({}) and calls it through start", () => {
    const importers = [join(ROOT, "extension.mjs"), join(ROOT, "wiring.mjs"), ...libFiles().map((f) => join(LIB, f))]
        .filter((file) => imports(read(file)).some((s) => s.startsWith("@github/copilot-sdk")))
        .map((file) => relative(ROOT, file));
    assert.deepEqual(importers, ["extension.mjs"]);
    assert.match(codeOnly(read(join(ROOT, "wiring.mjs"))), /\bawait joinSession\(\{\}\)/);
    assert.match(codeOnly(read(join(ROOT, "extension.mjs"))), /\bawait start\(\{[^}]*\bjoinSession\b/);
});

test("no turn-cost file uses console.log or additionalContext", () => {
    const files = extensionModules();
    assert.ok(files.length >= 10, "the scan found the extension files");
    for (const file of files) {
        assert.doesNotMatch(codeOnly(read(file)), /console\.log|additionalContext/, relative(ROOT, file));
    }
});

test("config.json lists every metric of METRICS with its default", () => {
    const config = JSON.parse(read(join(ROOT, "config.json")));
    assert.deepEqual(Object.keys(config), ["metrics"]);
    assert.deepEqual(Object.keys(config.metrics).sort(), [...METRICS].sort());
    assert.deepEqual(config.metrics, DEFAULT_METRICS);
});
