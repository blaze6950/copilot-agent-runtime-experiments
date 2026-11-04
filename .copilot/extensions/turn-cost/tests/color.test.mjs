// Tests for the colour helper (AC-6): NO_COLOR rule (no-color.org) and one cyan wrap per text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { colorEnabled, cyan } from "../lib/color.mjs";

test("colorEnabled: NO_COLOR set to a non-empty value disables colour", () => {
    assert.equal(colorEnabled({ NO_COLOR: "1" }), false);
    assert.equal(colorEnabled({ NO_COLOR: "0" }), false);
});

test("colorEnabled: unset or empty NO_COLOR keeps colour on", () => {
    assert.equal(colorEnabled({}), true);
    assert.equal(colorEnabled({ NO_COLOR: "" }), true);
    assert.equal(colorEnabled(undefined), true);
});

test("cyan wraps text in ESC[36m and ESC[0m when enabled", () => {
    assert.equal(cyan("abc", true), "\x1b[36mabc\x1b[0m");
});

test("cyan returns the text unchanged when disabled or empty", () => {
    assert.equal(cyan("abc", false), "abc");
    assert.equal(cyan("", true), "");
});
