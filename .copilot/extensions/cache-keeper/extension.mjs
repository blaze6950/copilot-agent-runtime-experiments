// cache-keeper extension entry point: wiring only (config, log, state file, session). Module map in lib/:
//   contracts (enums, typedefs) | config (defaults, merge) | tracker (events -> state) | policy (decisions)
//   transport (the only session access) | keeper (timers: tracker -> policy -> transport -> state file)
// Settings: config.json beside this file (env <ENV_NAME>_CONFIG=<path> overrides it); env <ENV_NAME>=off disables it.
// Never use console.log: stdout is the JSON-RPC channel.
import { joinSession } from "@github/copilot-sdk/extension";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_NAME, configPathFrom, mergeConfig, readUserConfig } from "./lib/config.mjs";
import { createKeeper } from "./lib/keeper.mjs";
import { createTransport } from "./lib/transport.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, "state");
const LOG_DIR = join(HERE, "logs");
mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });

let sessionId = "unknown";
const log = (msg) => {
    try { appendFileSync(join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`), `${new Date().toISOString()} ${sessionId.slice(0, 8)} ${msg}\n`); } catch { /* never throw */ }
};

// A missing config file is normal (defaults); a file that cannot be parsed is logged once and defaults apply.
const configPath = configPathFrom(process.env, join(HERE, "config.json"));
const { user, error: configError } = readUserConfig((p) => readFileSync(p, "utf8"), configPath);
if (configError) log(`config-error ${configPath}: ${configError}; using defaults`);
const cfg = mergeConfig(user, process.env, ENV_NAME);
if (cfg.problems.length) log(`config-warning ${cfg.problems.join("; ")}`);

if (!cfg.enabled) {
    await joinSession({});
    log("disabled");
} else {
    const session = await joinSession({});
    sessionId = session.sessionId ?? "unknown";
    const stateFile = join(STATE_DIR, `${sessionId}.json`);
    const writeState = (s) => { try { writeFileSync(stateFile, JSON.stringify(s)); } catch (e) { log(`state-error ${e}`); } };
    const keeper = createKeeper({ transport: createTransport(session, log), cfg, log, writeState });
    log(`start pid=${process.pid} ladder=${cfg.ladder.keepalives}+[${cfg.ladder.actions.map((a) => a.id).join(",")}] marginSec=${cfg.marginSec} rescue=${cfg.rescue.enabled}/${cfg.rescue.marginSec}s wait=${cfg.wait.enabled}/${cfg.wait.maxRefreshes}`);
    session.on((ev) => {
        keeper.onEvent(ev);
        if (ev.type === "session.shutdown") { try { rmSync(stateFile, { force: true }); } catch { /* ignore */ } }
    });
}