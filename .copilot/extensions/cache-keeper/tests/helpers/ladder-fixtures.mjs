// Shared ladder fixtures for the config and policy tests. Built with the real mergeConfig, never with fakes.
import { mergeConfig } from "../../lib/config.mjs";

/** Raw action as written in config.json: the default save step. */
export const SAVE_ACTION = { id: "save", command: "/save", when: { changedSinceLastRun: true, agents: ["1main"] }, ifRemoved: "retry" };

/** Raw action as written in config.json: the default compact step. */
export const COMPACT_ACTION = { id: "compact", command: "/compact", when: { minContextTokens: 150000 }, ifRemoved: "skip" };

/**
 * Config with the given ladder; other settings come from `over`.
 * @param {number} keepalives
 * @param {object[]} [actions]
 * @param {object} [over] other config.json keys
 */
export const ladderCfg = (keepalives, actions = [SAVE_ACTION, COMPACT_ACTION], over = {}) =>
    mergeConfig({ ...over, ladder: { keepalives, actions } });
