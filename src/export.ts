import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, PUBLIC_DEMO } from "./env.ts";
import { read, type Candidate, type Score, type Signal, type Run } from "./store.ts";
import { rubric, interval } from "./score.ts";
import { PERSONAS, REASONS } from "./rank.ts";
import { MONITOR_SPECS, loadMonitors } from "./monitors.ts";
import { buildCosts } from "./costs.ts";

// Everything the web UI needs, in one JSON document. Investors are created in the page, so no personas are exported.
const NEUTRAL = true;
export function buildData() {
  const R = rubric();
  const dimsPublic = R.dimensions.map((d) => ({ key: d.key, label: d.label, weight: PUBLIC_DEMO || NEUTRAL ? 100 / R.dimensions.length : d.weight }));
  const RW = { ...R, dimensions: R.dimensions.map((d, i) => ({ ...d, weight: dimsPublic[i].weight })) };
  const cands = read<Candidate[]>("candidates");
  const scores = read<Score[]>("scores").map((s) => ({ ...s, ...interval(s.dims, RW) }));
  const signals = read<Signal[]>("signals");
  const shown = cands.filter((c) => c.status === "digest" || c.status === "already_raised");
  // Watchlist: real startups seen in exactly one place so far. Not scored, not ranked, shown per sector.
  const sigById = new Map(signals.map((s) => [s.id, s]));
  const watch = cands.filter((c) => c.status === "gated_out" && c.sector !== "other" && c.signal_ids.some((id) => sigById.get(id)?.is_startup))
    .map((c) => ({ id: c.id, name: c.name, domains: c.domains.slice(0, 1), sector: c.sector, tags: c.tags ?? [], signal_ids: c.signal_ids.slice(0, 2), first_seen: c.first_seen }));
  const ids = new Set([...shown.flatMap((c) => c.signal_ids), ...watch.flatMap((c) => c.signal_ids)]);
  const spend: Record<string, number> = {};
  const f = join(DATA, "spend.jsonl");
  if (existsSync(f)) for (const l of readFileSync(f, "utf8").split("\n").filter(Boolean)) { const e = JSON.parse(l); spend[e.tool] = +((spend[e.tool] ?? 0) + e.usd).toFixed(4); }
  const bySource: Record<string, number> = {};
  for (const s of signals) bySource[s.source.split(":")[0]] = (bySource[s.source.split(":")[0]] ?? 0) + 1;
  const saved = loadMonitors();
  return {
    generated_at: new Date().toISOString(),
    public_demo: PUBLIC_DEMO || NEUTRAL,
    brand: "neutral",
    weights_note: NEUTRAL ? "Each investor sets their own rubric weights" : PUBLIC_DEMO ? "Equal demo weights across dimensions" : `Rubric v${R.version} working-draft weights`,
    personas: NEUTRAL ? {} : PERSONAS,
    reasons: REASONS,
    dims: dimsPublic,
    candidates: shown,
    watchlist: watch,
    scores: scores.filter((s) => shown.some((c) => c.id === s.candidate_id)),
    signals: Object.fromEntries(signals.filter((s) => ids.has(s.id)).map((s) => [s.id, { source: s.source, signal_type: s.signal_type, url: s.url, title: s.title, text: s.text, date: s.date, label: s.label }])),
    counts: {
      signals: signals.length, by_source: bySource, candidates: cands.length, gated_out: cands.filter((c) => c.status === "gated_out").length,
      not_us: cands.filter((c) => c.status === "not_us").length, location_unconfirmed: cands.filter((c) => c.status === "location_unconfirmed").length,
      digest: cands.filter((c) => c.status === "digest").length, already_raised: cands.filter((c) => c.status === "already_raised").length,
    },
    monitors: MONITOR_SPECS.filter((m) => saved[m.key]).map((m) => ({ key: m.key, query: m.query, include_domains: m.include_domains ?? [], cursor: read<Record<string, number>>("monitor_cursors", {})[saved[m.key].id] ?? 0 })),
    backtest: read<any>("backtest", null),
    runs: read<Run[]>("runs").slice(-12),
    spend,
    costs: buildCosts(),
    ablation: read<any>("ablation", null),
    memory_store: process.env.INSFORGE_URL && process.env.INSFORGE_ANON_KEY ? { url: process.env.INSFORGE_URL, anon_key: process.env.INSFORGE_ANON_KEY, table: "feedback_events" } : null,
  };
}
