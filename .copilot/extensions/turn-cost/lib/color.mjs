// Colour helpers for the turn-cost lines. Same NO_COLOR rule as extensions/cache-keeper/lib/statusline-render.mjs (no-color.org).

const CYAN_OPEN = "\x1b[36m";
const RESET = "\x1b[0m";

/** Colour is on unless NO_COLOR is set to a non-empty value. */
export function colorEnabled(env) {
    return !env?.NO_COLOR;
}

/** Wraps one text in cyan. Returns the text unchanged when colour is off or the text is empty. */
export function cyan(text, enabled) {
    return enabled && text !== "" ? `${CYAN_OPEN}${text}${RESET}` : text;
}
