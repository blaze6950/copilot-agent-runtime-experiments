// Status line for cache-keeper: reads the CLI status JSON on stdin and the extension's state file; prints one line or nothing.
// settings.json: "statusLine": { "command": "node <this file>", "refreshInterval": 5 }
// Reads the cache-keeper config on every run (statusLine.countdown), so a change applies at the next refresh.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configPathFrom, mergeConfig, readUserConfig } from "./lib/config.mjs";
import { render, colorEnabled } from "./lib/statusline-render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, "state");
const DEFAULT_CONFIG = join(HERE, "config.json");

/**
 * One status-line run: the line for the session named in the CLI status JSON, or "" when there is nothing to show.
 * Reads the state file and the config on every call, so a config change applies at the next refresh.
 * @param {string} stdinText the CLI status JSON
 * @param {{readText: (path: string) => string, env: Record<string, string|undefined>, now: number, stateDir: string, defaultConfigPath: string}} io
 * @returns {string}
 */
export function lineFor(stdinText, { readText, env, now, stateDir, defaultConfigPath }) {
    let state;
    try {
        const sid = JSON.parse(stdinText || "{}").session_id;
        if (!sid || !/^[\w-]+$/.test(sid)) return "";
        state = JSON.parse(readText(join(stateDir, `${sid}.json`)));
    } catch {
        return ""; // no state for this session
    }
    const { user } = readUserConfig(readText, configPathFrom(env, defaultConfigPath));
    const { statusLine } = mergeConfig(user, env);
    return render(state, now, { color: colorEnabled(env), countdown: statusLine.countdown });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    let input = "";
    process.stdin.on("data", (c) => (input += c));
    process.stdin.on("end", () => {
        try {
            const line = lineFor(input, {
                readText: (path) => readFileSync(path, "utf8"),
                env: process.env,
                now: Date.now(),
                stateDir: STATE_DIR,
                defaultConfigPath: DEFAULT_CONFIG,
            });
            if (line) process.stdout.write(line);
        } catch { /* print nothing */ }
    });
}
