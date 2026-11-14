import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, PUBLIC_DEMO } from "./env.ts";
import { read, write, addSignals, startRun, endRun, type Signal, type Candidate, type Score } from "./store.ts";
import { edgarFormD } from "./sources/edgar.ts";
import { githubStarVelocity } from "./sources/github.ts";
import { showHN } from "./sources/hn.ts";
import { tavilyMapDiff, tavily } from "./sources/tavily.ts";
import { extract } from "./extract.ts";
import { resolve } from "./resolve.ts";
import { applyRaisedGate, applyStatedRoundGate } from "./gates.ts";
import { scoreCandidates } from "./score.ts";
import { logSpend } from "./telem.ts";
import { corroborate } from "./corroborate.ts";
import { locate } from "./locate.ts";
import type { RawItem } from "./sources/edgar.ts";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const step = async <T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
  try { const t = Date.now(); const r = await fn(); console.log(`✓ ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`); return r; }
  catch (e: any) { console.log(`✗ ${name}: ${e.message?.slice(0, 200)}`); return fallback; }
};

export function seedNames(): string[] {
  const pub = read<{ name: string }[]>("seeds", []).map((s) => s.name);
  const privPath = join(ROOT, "seeds.local.json"); // your own list, kept out of git
  const priv = !PUBLIC_DEMO && existsSync(privPath) ? (JSON.parse(readFileSync(privPath, "utf8")).people ?? []).map((p: any) => p.name) : [];
  return [...pub, ...priv];
}

async function ingest() {
  const now = new Date();
  const raw: RawItem[] = [];
  const optional: [string, () => Promise<RawItem[]>][] = [
    ["telem monitors (seq cursor)", async () => (await import("./sources/telemIngest.ts")).ingestMonitorChanges()],
    ["telem pinned X / Product Hunt / LinkedIn posts", async () => (await import("./sources/telemIngest.ts")).pinnedSearches(seedNames())],
    ["telem security and verification discovery", async () => (await import("./sources/telemIngest.ts")).securityDiscovery()],
    ["tavily map diff", tavilyMapDiff],
    ["edgar form d", () => edgarFormD(iso(new Date(now.getTime() - 21 * 864e5)), iso(now))],
    ["github star velocity", () => githubStarVelocity(now)],
    ["show hn", () => showHN(now.getTime() - 21 * 864e5, now.getTime())],
  ];
  for (const [name, fn] of optional) raw.push(...(await step(`ingest: ${name}`, fn, [])));
  const known = new Set(read<Signal[]>("signals").map((s) => s.url));
  const fresh = raw.filter((r) => !known.has(r.url));
  console.log(`raw items: ${raw.length}, new: ${fresh.length}`);
  const sigs = await step("extract (claude, low effort)", () => extract(fresh), []);
  const added = addSignals(sigs);
  console.log(`signals added: ${added}`);
  return { raw: raw.length, fresh: fresh.length, signals_added: added };
}

async function enrich(cands: Candidate[]) {
  const ev: Record<string, { url: string; text: string }[]> = {};
  const withSite = cands.filter((c) => c.domains[0]);
  for (let i = 0; i < withSite.length; i += 20) {
    const chunk = withSite.slice(i, i + 20);
    try {
      const r = await tavily("extract", { urls: chunk.map((c) => `https://${c.domains[0]}`) });
      logSpend("tavily", "extract", Math.ceil(chunk.length / 5) * 0.008, `${chunk.length} urls`);
      for (const res of r.results ?? []) {
        const c = chunk.find((c) => String(res.url).includes(c.domains[0]));
        if (c && res.raw_content) ev[c.id] = [{ url: res.url, text: String(res.raw_content).slice(0, 3000) }];
      }
    } catch (e: any) { console.log("tavily extract:", e.message?.slice(0, 120)); }
  }
  return ev;
}

async function build() {
  let signals = read<Signal[]>("signals");
  let cands = resolve(signals, seedNames());
  await step("corroborate single-signal companies (telem search)", () => corroborate(cands, signals), undefined);
  signals = read<Signal[]>("signals");
  cands = resolve(signals, seedNames());
  console.log(`candidates: ${cands.length}, pass gate: ${cands.filter((c) => c.gate.pass).length}`);
  await step("gate: round stated in the signals", async () => console.log(`  moved: ${applyStatedRoundGate(cands, signals)}`), undefined);
  await step("gate: monid already-raised", async () => console.log(`  fundable rows: ${applyRaisedGate(cands)}`), undefined);
  // US-only: a company stays in the digest only when one of its sources states a US location.
  await step("gate: US-based (location stated in a source)", async () => {
    const pass = cands.filter((c) => c.gate.pass);
    const loc = await locate(pass, signals);
    for (const c of pass) {
      const l = loc[c.id];
      c.location = l ? { country: l.country, us: l.us, place: l.place, quote: l.quote, url: l.url } : null;
      if (c.status !== "digest") continue;
      if (l?.us === false) c.status = "not_us";
      else if (!l || l.us === null) c.status = "location_unconfirmed";
    }
    console.log(`  US: ${cands.filter((c) => c.status === "digest").length}, non-US: ${cands.filter((c) => c.status === "not_us").length}, unconfirmed: ${cands.filter((c) => c.status === "location_unconfirmed").length}`);
  }, undefined);
  write("candidates", cands);
  const digest = cands.filter((c) => c.status === "digest");
  const prev = new Map(read<Score[]>("scores").map((s) => [s.candidate_id, s]));
  const sigCount = (c: Candidate) => c.signal_ids.length;
  const SCORE_MAX = Number(process.env.SCORE_MAX ?? 70);
  const byStrength = [...digest].sort((a, b) => b.sources.length - a.sources.length || b.signal_ids.length - a.signal_ids.length);
  // Security companies are always scored so the security persona has a full list; the rest fill the remaining slots.
  const sec = byStrength.filter((c) => c.sector === "security").slice(0, 20);
  const strongest = [...sec, ...byStrength.filter((c) => c.sector !== "security")].slice(0, SCORE_MAX);
  const todo = strongest.filter((c) => !prev.has(c.id) || (prev.get(c.id) as any).n_signals !== sigCount(c));
  const evidence = await step("enrich: tavily extract of company sites", () => enrich(todo), {});
  const fresh = await step(`score ${todo.length} candidates (claude, high effort)`, () => scoreCandidates(todo, signals, evidence), []);
  for (const s of fresh) prev.set(s.candidate_id, { ...s, n_signals: sigCount(digest.find((c) => c.id === s.candidate_id)!) } as any);
  write("scores", [...prev.values()]);
  const counts = { candidates: cands.length, digest: digest.length, already_raised: cands.filter((c) => c.status === "already_raised").length, scored_now: fresh.length };
  console.log(`digest: ${digest.length}, already raised: ${cands.filter((c) => c.status === "already_raised").length}, scored: ${prev.size}`);
  return counts;
}

const cmd = process.argv[2] ?? "all";
for (const [kind, fn] of [["ingest", ingest], ["build", build]] as const) {
  if (cmd !== kind && cmd !== "all") continue;
  const run = startRun(kind);
  try { const done = endRun(run, (await fn()) as any); console.log(`run ${done.id} ${kind}: $${done.usd} ${JSON.stringify(done.by_tool)}`); }
  catch (e: any) { endRun(run, {}, "failed"); throw e; }
}
