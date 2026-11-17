// Investor memory API: append-only votes and investor profiles, one Postgres database.
// The page calls the same paths it used before, so only its memory_store.url changes.
// Insert and select only. Every read and write is scoped to one memory space; there is no list-all and no delete.
import { createServer } from "node:http";
import pg from "pg";

const PORT = Number(process.env.PORT ?? 10000);
const ORIGINS = (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const INVESTOR = new RegExp(process.env.INVESTOR_PATTERN ?? "^[A-Za-z0-9]{1,20}$");
const REASONS = new Set(["love_space", "love_founder", "wrong_sector", "too_late", "weak_founder_fit", "not_ai_native", "note"]);
const SPACE = /^[a-z0-9]{2,40}$/;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4, ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false } });
await pool.query(`
  CREATE TABLE IF NOT EXISTS feedback_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    investor text NOT NULL CHECK (investor ~ '^[A-Za-z0-9]{1,20}$'),
    candidate_id text NOT NULL CHECK (char_length(candidate_id) <= 40),
    vote smallint NOT NULL CHECK (vote IN (1, -1)),
    reason text NOT NULL CHECK (reason IN ('love_space', 'love_founder', 'wrong_sector', 'too_late', 'weak_founder_fit', 'not_ai_native', 'note')),
    session text NOT NULL CHECK (session ~ '^[a-z0-9]{2,40}$'),
    note text CHECK (char_length(note) <= 280),
    at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS feedback_events_session_idx ON feedback_events (session, at);
  CREATE TABLE IF NOT EXISTS profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id text NOT NULL CHECK (profile_id ~ '^[a-z0-9]{2,20}$'),
    space text NOT NULL CHECK (space ~ '^[a-z0-9]{2,40}$'),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
    prefs jsonb NOT NULL CHECK (pg_column_size(prefs) < 4000),
    at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS profiles_space_idx ON profiles (space, at);
`);

// Small per-address write limit, in memory. Enough to stop a loop from filling a free database.
const hits = new Map();
const limited = (ip) => {
  const now = Date.now(), h = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  h.push(now); hits.set(ip, h);
  if (hits.size > 5000) hits.clear();
  return h.length > 40;
};

const send = (res, code, body, origin) => {
  res.writeHead(code, {
    "Content-Type": "application/json",
    ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin", "Access-Control-Allow-Headers": "authorization, content-type, prefer", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Max-Age": "86400" } : {}),
  });
  res.end(body === undefined ? "" : JSON.stringify(body));
};
const eq = (v) => (typeof v === "string" && v.startsWith("eq.") ? v.slice(3) : null);
const readBody = async (req) => {
  let s = "";
  for await (const c of req) { s += c; if (s.length > 8000) throw new Error("too large"); }
  const j = JSON.parse(s);
  return Array.isArray(j) ? j[0] : j;
};

createServer(async (req, res) => {
  const o = req.headers.origin;
  const origin = o && ORIGINS.includes(o) ? o : null;
  try {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/healthz") return send(res, 200, { ok: true }, origin);
    if (req.method === "OPTIONS") return send(res, origin ? 204 : 403, undefined, origin);
    const table = url.pathname.match(/^\/api\/database\/records\/(feedback_events|profiles)$/)?.[1];
    if (!table) return send(res, 404, { error: "not found" }, origin);
    const key = table === "profiles" ? "space" : "session";

    if (req.method === "GET") {
      const space = eq(url.searchParams.get(key));
      if (!space || !SPACE.test(space)) return send(res, 400, { error: `${key}=eq.<space> is required` }, origin);
      const q = table === "profiles"
        ? "SELECT profile_id, space, name, prefs, at FROM profiles WHERE space = $1 ORDER BY at ASC LIMIT 500"
        : "SELECT investor, candidate_id, vote, reason, note, session, at FROM feedback_events WHERE session = $1 ORDER BY at ASC LIMIT 1000";
      return send(res, 200, (await pool.query(q, [space])).rows, origin);
    }

    if (req.method === "POST") {
      // Browsers send an Origin header; a write from a page that is not this site's is refused.
      if (o && !origin) return send(res, 403, { error: "origin not allowed" }, null);
      const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim();
      if (limited(ip)) return send(res, 429, { error: "slow down" }, origin);
      const b = await readBody(req);
      if (table === "profiles") {
        const ok = b && /^[a-z0-9]{2,20}$/.test(String(b.profile_id)) && SPACE.test(String(b.space)) && typeof b.name === "string" && b.name.length >= 1 && b.name.length <= 40 && b.prefs && typeof b.prefs === "object" && JSON.stringify(b.prefs).length < 3500;
        if (!ok) return send(res, 400, { error: "bad profile" }, origin);
        const r = await pool.query("INSERT INTO profiles (profile_id, space, name, prefs) VALUES ($1, $2, $3, $4) RETURNING profile_id, space, name, prefs, at", [b.profile_id, b.space, b.name, JSON.stringify(b.prefs)]);
        return send(res, 201, r.rows, origin);
      }
      const note = typeof b?.note === "string" && b.note.trim() ? b.note.slice(0, 280) : null;
      const ok = b && INVESTOR.test(String(b.investor)) && typeof b.candidate_id === "string" && b.candidate_id.length >= 1 && b.candidate_id.length <= 40 && (b.vote === 1 || b.vote === -1) && REASONS.has(b.reason) && SPACE.test(String(b.session));
      if (!ok) return send(res, 400, { error: "bad feedback" }, origin);
      const r = await pool.query("INSERT INTO feedback_events (investor, candidate_id, vote, reason, session, note) VALUES ($1, $2, $3, $4, $5, $6) RETURNING investor, candidate_id, vote, reason, note, session, at", [b.investor, b.candidate_id, b.vote, b.reason, b.session, note]);
      return send(res, 201, r.rows, origin);
    }
    return send(res, 405, { error: "method not allowed" }, origin);
  } catch (e) {
    console.error("request failed:", e?.message);
    return send(res, 400, { error: "bad request" }, origin);
  }
}).listen(PORT, () => console.log(`memory api on :${PORT}, origins: ${ORIGINS.join(", ") || "none"}`));
