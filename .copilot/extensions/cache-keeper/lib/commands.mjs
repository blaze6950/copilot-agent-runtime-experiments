// Pure helpers for slash command lines ("/name", "/name some argument"). One rule for "which command is this", used by the tracker, the keeper and unblock.

/** First whitespace-separated token of a command line, e.g. "/name" for "/name now". */
export const commandToken = (text) => String(text ?? "").trim().split(/\s+/)[0];

/** The command's name without the leading slash ("name"), as the CLI reports it in `skill.invoked`. */
export const commandName = (text) => commandToken(text).replace(/^\//, "");
