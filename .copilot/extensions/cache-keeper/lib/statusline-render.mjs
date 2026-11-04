// Status line rendering: pure (no node: imports), so every rule is table-testable. statusline.mjs is the CLI entry that feeds it.
const STALE_MS = 24 * 3600 * 1000;
// ASCII only: wide glyphs (emoji) break column math in some consoles and leave stale digits behind.
/** Local wall-clock time HH:MM:SS of an epoch ms value (seconds truncated). */
export function clockTime(ms) {
    const d = new Date(ms);
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}
/** Time left as m:ss, or h:mm:ss from one hour; seconds rounded up, never negative. */
export function remainingTime(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
/** Nano-AIU per US dollar: dollars = copilotUsage.totalNanoAiu / 1e11 (checked to the cent against the CLI's cost counter). */
const NANO_AIU_PER_USD = 1e11;
const usd = (nanoAiu) => `$${(nanoAiu / NANO_AIU_PER_USD).toFixed(2)}`;
/** Refresh kinds whose price is shown in the green phase (keep-alives of the idle and the wait ladder), with their label. */
const PRICED_KINDS = Object.freeze({ keepalive: "keepalive", wait: "wait keepalive" });
/** Texts for PublishedState.waitEnd (a running task, nothing will be sent). */
const WAIT_END_TEXT = Object.freeze({ cap: "wait budget used, no more keep-alives", off: "wait keep-alives off, no more keep-alives" });
// Older state files have no nextLabel: fall back to the action name.
const nextLabel = (st) => st.nextLabel ?? (st.nextAction === "wait" ? "keepalive" : st.nextAction);
const stepCounter = (st) => st.nextAction === "wait" ? ` (wait ${st.waitRefreshes + 1}/${st.maxWaitRefreshes})`
    : Number.isInteger(st.step) && Number.isInteger(st.steps) ? ` (${st.step}/${st.steps})` : "";
/**
 * "keepalive #3 $0.12", or "keepalive #3 saved $2.39 ($0.12)" when the saving is known (the cost in parentheses),
 * for the last priced refresh; null for other kinds and when there is no cost field. A cache miss has no saving.
 */
function pricePart(st) {
    const label = Object.hasOwn(PRICED_KINDS, st.lastRefreshKind) ? PRICED_KINDS[st.lastRefreshKind] : null;
    if (!label || typeof st.lastRefreshNanoAiu !== "number") return null;
    const count = st.lastRefreshKind === "wait" ? st.waitRefreshes : st.keepalives;
    const head = `${label}${Number.isInteger(count) ? ` #${count}` : ""}`;
    return typeof st.lastRefreshSavedNanoAiu === "number"
        ? `${head} saved ${usd(st.lastRefreshSavedNanoAiu)} (${usd(st.lastRefreshNanoAiu)})`
        : `${head} ${usd(st.lastRefreshNanoAiu)}`;
}

/** A keeper-initiated refresh is flashed green for this long after its lastRefreshAt. */
export const FLASH_MS = 6000;

const sgr = (code, text) => `\x1b[${code}m${text}\x1b[0m`;

/** Colour is on unless NO_COLOR is set to a non-empty value (no-color.org). */
export function colorEnabled(env) {
    return !env?.NO_COLOR;
}

/**
 * One status line, or "" when there is nothing to show or the state is older than 24 h.
 * With `color`, the whole line is red while the cache is expired (red wins), otherwise green for FLASH_MS after a keeper refresh.
 * With `countdown`, each clock time (cache expiry, next step, rescue) is followed by its remaining time in brackets.
 */
export function render(st, now = Date.now(), { color = false, countdown = false } = {}) {
    if (!st?.updatedAt || now - st.updatedAt > STALE_MS) return "";
    const at = (ms) => (countdown ? `${clockTime(ms)} (${remainingTime(ms - now)})` : clockTime(ms));
    const parts = [];
    let expired = false;
    if (st.expiresAt) {
        if (st.expiresAt > now) parts.push(`cache until ${at(st.expiresAt)}${st.provisional ? " (refreshing)" : ""}`);
        else expired = true;
    }
    if (st.ladderDone === true && st.idle && st.nextAction !== "wait") parts.push("ladder done, waiting for you");
    if (!st.nextAction && typeof st.waitEnd === "string" && Object.hasOwn(WAIT_END_TEXT, st.waitEnd)) parts.push(WAIT_END_TEXT[st.waitEnd]);
    if (st.nextAt && st.nextAction) parts.push(`next ${nextLabel(st)} ${at(st.nextAt)}${stepCounter(st)}`);
    if (!st.idle && st.rescueAt && st.busyTools?.length) parts.push(`busy in ${st.busyTools.join(",")}, rescue ${at(st.rescueAt)}`);
    const flashing = typeof st.lastRefreshAt === "number" && now - st.lastRefreshAt < FLASH_MS;
    const price = flashing ? pricePart(st) : null;
    if (price) parts.push(price);
    const body = parts.join(" | ");
    let line;
    if (expired) line = body ? `!! main cache expired !! | ${body}` : "!! main cache expired !!";
    else if (body) line = `main ${body}`;
    else return "";
    if (!color) return line;
    if (expired) return sgr(31, line);
    if (flashing) return sgr(32, line);
    return line;
}
