// SQL classifier of the shell governor (ported from the S4 spike sql.mjs; logic unchanged). SQL text passed to snow,
// usql and sqlite3 is stripped of comments, split into statements and classified by its main verb. Pure functions.
//
// Rules: strip -- and /* */ comments; split on ';' outside quotes and $$ bodies; mask string literals and quoted
// identifiers; main verb at paren depth 0 (WITH -> first SELECT/INSERT/UPDATE/DELETE/MERGE).
// read = SELECT, SHOW, DESCRIBE/DESC, EXPLAIN, LIST/LS (SELECT calling SYSTEM$ other than PIPE_STATUS/CLUSTERING_INFORMATION/TYPEOF
// -> execute; NEXTVAL or top-level INTO -> unknown); session = USE, SET/UNSET, ALTER SESSION, BEGIN/START TRANSACTION, COMMIT, ROLLBACK;
// scratch = CREATE [OR REPLACE] [TRANSIENT] TEMPORARY TABLE (-> unknown); execute = CALL, EXECUTE, BEGIN..END, DECLARE, GET;
// write = INSERT, UPDATE, MERGE, COPY INTO, PUT; delete = DELETE, TRUNCATE, DROP, REMOVE/RM; admin = CREATE (non-temp), ALTER (non-session),
// UNDROP, GRANT, REVOKE, COMMENT. Script class = max severity; unresolvable -> unknown.

const SEVERITY = ["read", "session", "execute", "write", "delete", "admin", "unknown"];

/** Removes -- and block comments outside string literals and quoted identifiers. */
export function stripComments(sql) {
    let out = "";
    let i = 0;
    while (i < sql.length) {
        const c = sql[i];
        if (c === "'" || c === '"') {
            const q = c;
            out += c; i++;
            while (i < sql.length) {
                if (sql[i] === q) { if (sql[i + 1] === q) { out += q + q; i += 2; continue; } out += q; i++; break; }
                out += sql[i]; i++;
            }
            continue;
        }
        if (c === "-" && sql[i + 1] === "-") { while (i < sql.length && sql[i] !== "\n") i++; continue; }
        if (c === "/" && sql[i + 1] === "*") { const e = sql.indexOf("*/", i + 2); i = e < 0 ? sql.length : e + 2; out += " "; continue; }
        out += c; i++;
    }
    return out;
}

/** Splits on ';' outside quotes and $$ bodies. Returns non-empty statements. */
export function splitStatements(sql) {
    const parts = [];
    let cur = "";
    let i = 0;
    let dollar = false;
    while (i < sql.length) {
        const c = sql[i];
        if (!dollar && (c === "'" || c === '"')) {
            const q = c; cur += c; i++;
            while (i < sql.length) {
                if (sql[i] === q) { if (sql[i + 1] === q) { cur += q + q; i += 2; continue; } cur += q; i++; break; }
                cur += sql[i]; i++;
            }
            continue;
        }
        if (sql.startsWith("$$", i)) { dollar = !dollar; cur += "$$"; i += 2; continue; }
        if (!dollar && c === ";") { parts.push(cur); cur = ""; i++; continue; }
        cur += c; i++;
    }
    parts.push(cur);
    return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Replaces string-literal and quoted-identifier contents (and $$ bodies) with spaces, keeping length. */
function maskLiterals(stmt) {
    let out = "";
    let i = 0;
    let dollar = false;
    while (i < stmt.length) {
        const c = stmt[i];
        if (stmt.startsWith("$$", i)) { dollar = !dollar; out += "  "; i += 2; continue; }
        if (dollar) { out += " "; i++; continue; }
        if (c === "'" || c === '"') {
            const q = c; out += q; i++;
            while (i < stmt.length) {
                if (stmt[i] === q) { if (stmt[i + 1] === q) { out += "  "; i += 2; continue; } out += q; i++; break; }
                out += " "; i++;
            }
            continue;
        }
        out += c; i++;
    }
    return out;
}

/** Word tokens with their paren depth (upper-cased). */
function wordTokens(masked) {
    const toks = [];
    let depth = 0;
    const re = /[A-Za-z_$][A-Za-z0-9_$]*|\(|\)/g;
    let m;
    while ((m = re.exec(masked))) {
        const t = m[0];
        if (t === "(") { depth++; continue; }
        if (t === ")") { depth = Math.max(0, depth - 1); continue; }
        toks.push({ w: t.toUpperCase(), depth });
    }
    return toks;
}

function classOfStatement(stmt) {
    const masked = maskLiterals(stmt);
    const all = wordTokens(masked);
    if (all.length === 0) return { cls: "unknown", reason: "no words" };
    const top = all.filter((t) => t.depth === 0).map((t) => t.w);
    let verb = top[0];
    const hasDollarBody = stmt.includes("$$");
    if (verb === "WITH") {
        const first = all.find((t) => t.depth === 0 && ["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE"].includes(t.w));
        verb = first ? first.w : "WITH";
    }
    const words = all.map((t) => t.w);
    switch (verb) {
        case "SELECT": {
            const fn = masked.match(/SYSTEM\$([A-Za-z_]+)/i);
            if (fn) {
                const name = fn[1].toUpperCase();
                if (!["PIPE_STATUS", "CLUSTERING_INFORMATION", "TYPEOF"].includes(name)) return { cls: "execute", reason: "SYSTEM$" + name };
            }
            if (words.includes("NEXTVAL")) return { cls: "unknown", reason: "NEXTVAL" };
            if (top.includes("INTO")) return { cls: "unknown", reason: "SELECT INTO" };
            return { cls: "read", reason: "SELECT" };
        }
        case "SHOW": case "DESCRIBE": case "DESC": case "EXPLAIN": case "LIST": case "LS":
            return { cls: "read", reason: verb };
        case "USE": case "SET": case "UNSET": case "COMMIT": case "ROLLBACK":
            return { cls: "session", reason: verb };
        case "BEGIN":
            if (words.includes("END") || hasDollarBody) return { cls: "execute", reason: "BEGIN..END" };
            return { cls: "session", reason: "BEGIN" };
        case "START":
            return top[1] === "TRANSACTION" ? { cls: "session", reason: "START TRANSACTION" } : { cls: "unknown", reason: "START" };
        case "ALTER":
            return top[1] === "SESSION" ? { cls: "session", reason: "ALTER SESSION" } : { cls: "admin", reason: "ALTER" };
        case "CREATE": {
            if (top.some((w) => w === "TEMPORARY" || w === "TEMP") && top.includes("TABLE")) return { cls: "unknown", reason: "TEMPORARY TABLE (scratch)" };
            return { cls: "admin", reason: hasDollarBody ? "CREATE with $$ body" : "CREATE" };
        }
        case "CALL": case "EXECUTE": case "DECLARE": case "GET":
            return { cls: "execute", reason: verb };
        case "INSERT": case "UPDATE": case "MERGE": case "PUT":
            return { cls: "write", reason: verb };
        case "COPY":
            return top[1] === "INTO" ? { cls: "write", reason: "COPY INTO" } : { cls: "unknown", reason: "COPY" };
        case "DELETE": case "TRUNCATE": case "DROP": case "REMOVE": case "RM":
            return { cls: "delete", reason: verb };
        case "UNDROP": case "GRANT": case "REVOKE": case "COMMENT":
            return { cls: "admin", reason: verb };
        default:
            return { cls: "unknown", reason: "verb " + (verb ?? "none") };
    }
}

/** Classifies SQL text: cls = max severity over statements (unknown is the top). */
export function classifySql(text) {
    if (typeof text !== "string" || text.trim() === "") return { cls: "unknown", statements: [], reason: "empty" };
    const stripped = stripComments(text);
    if (/^\s*begin\b/i.test(stripped) && /\bend\s*;?\s*$/i.test(stripped.trim())) return { cls: "execute", statements: [{ cls: "execute", reason: "BEGIN..END block" }] };
    const stmts = splitStatements(stripped);
    if (stmts.length === 0) return { cls: "read", statements: [], reason: "only comments" };
    const results = stmts.map(classOfStatement);
    let worst = "read";
    for (const r of results) if (SEVERITY.indexOf(r.cls) > SEVERITY.indexOf(worst)) worst = r.cls;
    return { cls: worst, statements: results };
}

/** Dot-commands of the sqlite3 shell. */
export function classifySqliteDot(text) {
    const w = text.trim().split(/\s+/)[0].toLowerCase();
    if ([".tables", ".schema", ".headers", ".mode", ".help", ".indexes", ".databases", ".dbinfo"].includes(w)) return { cls: "read", reason: w };
    if ([".shell", ".system", ".read"].includes(w)) return { cls: "execute", reason: w };
    return { cls: "unknown", reason: w };
}
