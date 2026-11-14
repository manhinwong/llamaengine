import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DATA } from "./env.ts";

export type Label = "F" | "V" | "A";
export type Signal = {
  id: string;
  source: string; // telem_monitor:<key> | telem_x | telem_producthunt | telem_linkedin | tavily_map | edgar_formd | github | hn | monid_profile
  signal_type: string; // launch_post | hiring | show_hn | paper | left_job | cohort | form_d | star_velocity | linkedin_post | x_post | producthunt | lab_roster_change | title_change
  url: string;
  title: string;
  text: string; // display summary written by the engine. Never used as scoring evidence.
  raw?: string; // text as returned by the primary source. The only text scoring may read.
  date: string | null;
  label: Label;
  company?: string | null;
  domain?: string | null;
  people?: string[];
  linkedin?: string | null;
  github?: string | null;
  sector?: string | null;
  tags?: string[];
  seed_person?: boolean;
  strong?: boolean;
  is_startup?: boolean;
  ingested_at: string;
  run?: string; // "live" | "backtest"
};
export type Candidate = {
  id: string;
  name: string;
  domains: string[];
  linkedin: string[];
  github: string[];
  people: string[];
  signal_ids: string[];
  signal_types: string[];
  sources: string[];
  first_seen: string | null;
  sector: string;
  tags?: string[];
  seed_hit: boolean;
  gate: { pass: boolean; reason: string };
  status: "digest" | "already_raised" | "gated_out" | "not_us" | "location_unconfirmed";
  location?: { country: string | null; us: boolean | null; place: string | null; quote: string | null; url: string | null } | null;
  raised?: { round: string; date: string | null; source: string } | null;
};
export type DimScore = { level: number | "U"; rationale: string; claims: { text: string; label: Label; url: string }[] };
export type Score = { candidate_id: string; dims: Record<string, DimScore>; P: number; C: number; lower: number; upper: number; scored_at: string };
export type Feedback = { investor: string; candidate_id: string; vote: 1 | -1; reason: string; at: string; note?: string | null };

const tables = ["investors", "seeds", "monitor_cursors", "signals", "candidates", "scores", "feedback"] as const;
type Table = (typeof tables)[number];
const file = (t: string) => join(DATA, `${t}.json`);

export function read<T = any>(t: Table | string, fallback: any = []): T {
  return existsSync(file(t)) ? JSON.parse(readFileSync(file(t), "utf8")) : fallback;
}
export function write(t: Table | string, v: unknown) {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(file(t), JSON.stringify(v, null, 1));
}
export const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

export function addSignals(newOnes: Omit<Signal, "id" | "ingested_at">[], table = "signals"): number {
  const all = read<Signal[]>(table);
  const seen = new Set(all.map((s) => s.id));
  let n = 0;
  for (const s of newOnes) {
    const id = hash(`${s.source}|${s.url}|${s.signal_type}`);
    if (seen.has(id)) continue;
    seen.add(id);
    all.push({ ...s, id, ingested_at: new Date().toISOString() });
    n++;
  }
  write(table, all);
  return n;
}

export type Run = { id: string; kind: string; started_at: string; ended_at: string | null; status: "running" | "done" | "failed"; counts: Record<string, number>; usd: number; by_tool: Record<string, number> };
const spendSince = (iso: string) => {
  const f = join(DATA, "spend.jsonl");
  const by: Record<string, number> = {};
  if (existsSync(f)) for (const l of readFileSync(f, "utf8").split("\n").filter(Boolean)) { const e = JSON.parse(l); if (e.at >= iso) by[e.tool] = (by[e.tool] ?? 0) + e.usd; }
  return by;
};
// Every ingest, scoring batch and backtest is recorded here with its cost.
export function startRun(kind: string): Run {
  const runs = read<Run[]>("runs");
  const live = runs.find((r) => r.kind === kind && r.status === "running" && Date.now() - Date.parse(r.started_at) < 20 * 60e3);
  if (live) { console.error(`A "${kind}" run started at ${live.started_at} is still marked running; refusing to start a second one.`); process.exit(3); }
  const run: Run = { id: hash(kind + Date.now()), kind, started_at: new Date().toISOString(), ended_at: null, status: "running", counts: {}, usd: 0, by_tool: {} };
  write("runs", [...runs, run]);
  return run;
}
export function endRun(run: Run, counts: Record<string, number>, status: "done" | "failed" = "done") {
  const by = spendSince(run.started_at);
  const done = { ...run, ended_at: new Date().toISOString(), status, counts, by_tool: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, +v.toFixed(4)])), usd: +Object.values(by).reduce((a, b) => a + b, 0).toFixed(4) };
  write("runs", read<Run[]>("runs").map((r) => (r.id === run.id ? done : r)));
  return done;
}
