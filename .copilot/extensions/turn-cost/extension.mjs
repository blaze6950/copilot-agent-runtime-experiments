// turn-cost extension entry point: the only SDK import. It creates the log file and the metric reader, then calls start() in wiring.mjs.
// Module map in lib/:
//   contracts (enums, defaults) | config (strict metric config) | accounting (events -> blocks) | render (blocks -> text)
//   color (NO_COLOR) | format (numbers) | intervals (time windows) | reporter (blocks -> lines) | transport (the only session.log call)
// Output: one info line per finished turn and per finished sub-agent, through session.log. The metric config is read before every block.
// Kill switch: COPILOT_TURN_COST=off still joins the session, logs one line to the extension's own log and subscribes to nothing (see wiring.mjs).
// Never use console.log: stdout is the JSON-RPC channel. Nothing is sent to the model.
import { joinSession } from "@github/copilot-sdk/extension";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { metricConfigFrom } from "./lib/config.mjs";
import { start } from "./wiring.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(HERE, "logs");
try { mkdirSync(LOG_DIR, { recursive: true }); } catch { /* logging stays best effort */ }

let sessionId = "unknown";
const log = (msg) => {
    try { appendFileSync(join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`), `${new Date().toISOString()} ${sessionId.slice(0, 8)} ${msg}\n`); } catch { /* never throw */ }
};

const configPath = join(HERE, "config.json");
const readMetrics = () => metricConfigFrom((p) => readFileSync(p, "utf8"), configPath);

await start({ env: process.env, joinSession, log, setSessionId: (id) => { sessionId = id; }, readMetrics });
