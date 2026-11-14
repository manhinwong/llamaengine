// Blind backtest: run the engine's own queries as of a cutoff 90 days ago, with no company names,
// using only self-dated signals. Answer key: pre-seed/seed rounds announced after the cutoff (Monid Fundable).
import "./env.ts";
import { read, write, addSignals, startRun, endRun, type Signal } from "./store.ts";
import { MONITOR_SPECS } from "./monitors.ts";
import { telemSearch } from "./sources/telemIngest.ts";
import { edgarFormD, type RawItem } from "./sources/edgar.ts";
import { githubAsOf } from "./sources/github.ts";
import { showHN } from "./sources/hn.ts";
import { extract } from "./extract.ts";
import { resolve, normName, cleanDomain } from "./resolve.ts";
import { monid, fundableByDomains, type FundableCo } from "./monid.ts";
import { corroborate } from "./corroborate.ts";
import * as monidState from "./monid.ts";

const DAY = 864e5;
const now = new Date();
const cutoff = new Date(now.getTime() - 90 * DAY);
const windowStart = new Date(cutoff.getTime() - 60 * DAY);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const KEY_ROWS = Number(process.env.BACKTEST_KEY_ROWS ?? 300); // $0.06 per row

const PINNED_BT = [
  { provider: "apify_linkedin", source: "telem_linkedin", type: "linkedin_post", q: "starting a new robotics company stealth" },
  { provider: "apify_linkedin", source: "telem_linkedin", type: "linkedin_post", q: "excited to announce I left to start a new AI company" },
  { provider: "fetchlayer_x", source: "telem_x", type: "x_post", q: "launching our robotics startup today out of stealth" },
];

async function collect() {
  const raw: RawItem[] = [];
  let undated = 0, afterCutoff = 0, telemTotal = 0;
  const keep = (source: string, type: string, rs: Awaited<ReturnType<typeof telemSearch>>) => {
    for (const r of rs) {
      telemTotal++;
      const t = r.publish_date ? Date.parse(r.publish_date) : NaN;
      if (Number.isNaN(t)) { undated++; continue; } // cannot prove it predates the cutoff: excluded and counted
      if (t > cutoff.getTime() || t < windowStart.getTime()) { afterCutoff++; continue; }
      raw.push({ source, signal_type: type, url: r.url, title: r.title, text: `${r.summary ?? ""} ${r.excerpt ?? ""}`.slice(0, 1200), date: new Date(t).toISOString(), label: "F" });
    }
  };
  const TYPE: Record<string, string> = { stealth_launch: "launch_post", founding_engineer: "hiring", show_hn: "show_hn", arxiv_spinout: "paper", left_to_start: "left_job", hardware_stealth: "hiring", accelerator_cohort: "cohort" };
  for (const m of MONITOR_SPECS) {
    try {
      keep(`telem_monitor:${m.key}`, TYPE[m.key], await telemSearch(m.query, { num: 20, published_after: iso(windowStart), published_before: iso(cutoff), include_domains: m.include_domains, op: "backtest:search" }));
    } catch (e: any) { console.log(`telem search ${m.key} failed: ${e.message?.slice(0, 140)}`); }
  }
  for (const p of PINNED_BT) {
    try {
      keep(p.source, p.type, await telemSearch(p.q, { providers: [p.provider], num: 20, published_after: iso(windowStart), published_before: iso(cutoff), op: `backtest:${p.provider}` }));
    } catch (e: any) { console.log(`pinned ${p.provider} failed: ${e.message?.slice(0, 140)}`); }
  }
  console.log(`telem: ${telemTotal} results, ${undated} undated (dropped), ${afterCutoff} outside window (dropped)`);
  const formd = await edgarFormD(iso(windowStart), iso(cutoff)).catch(() => []);
  const hn = await showHN(windowStart.getTime(), cutoff.getTime(), 40, 4).catch(() => []);
  const gh = await githubAsOf(cutoff).catch((e) => (console.log("github:", e.message), { items: [], undated: 0 }));
  console.log(`form d: ${formd.length}, show hn: ${hn.length}, github: ${gh.items.length}`);
  return { raw: [...raw, ...formd, ...hn, ...gh.items], undated, afterCutoff, telemTotal };
}

function answerKey(): FundableCo[] {
  // Three 30-day windows after the cutoff, up to KEY_ROWS/3 rows each, so the sample spans the whole period.
  // Each window is pulled once and cached; type SEED includes pre-seed rounds (pre: true on the deal).
  const windows = read<Record<string, FundableCo[]>>("backtest_key_windows", {});
  const legacy = read<FundableCo[] | null>("backtest_key", null as any);
  const per = Math.min(100, Math.ceil(KEY_ROWS / 3));
  for (let w = 0; w < 3; w++) {
    const from = new Date(cutoff.getTime() + w * 30 * DAY);
    const to = w === 2 ? now : new Date(cutoff.getTime() + (w + 1) * 30 * DAY - DAY);
    const k = `${iso(from)}..${iso(to)}`;
    if (windows[k]) continue;
    if (w === 2 && legacy?.length) { windows[k] = legacy; continue; } // the first pull was the most recent rounds
    try {
      windows[k] = monid("fundable", "/companies", { company: { super_categories: ["artificial-intelligence-e551"] }, latest_deal: { financing_types: [{ type: "SEED" }], date_start: iso(from), date_end: iso(to) }, page: 0, page_size: per }, "backtest:answer_key").companies ?? [];
      write("backtest_key_windows", windows);
    } catch (e: any) { console.log(`answer key window ${k}: ${String(e.message).slice(0, 200)}`); }
  }
  write("backtest_key_windows", windows);
  const all = Object.values(windows).flat().filter((c) => c.latest_deal && Date.parse(c.latest_deal.date) > cutoff.getTime());
  return [...new Map(all.map((c) => [c.domain ?? c.name, c])).values()];
}

const run = startRun("backtest");
const { raw, undated, afterCutoff, telemTotal } = await collect();
const known = new Set(read<Signal[]>("signals_backtest").map((s) => s.url));
const fresh = raw.filter((r) => !known.has(r.url));
addSignals(await extract(fresh, "backtest"), "signals_backtest");
let signals = read<Signal[]>("signals_backtest");
// Same corroboration step as the live run, limited to pages dated on or before the cutoff.
const corr = await corroborate(resolve(signals, []), signals, { table: "signals_backtest", before: cutoff, max: 80, run: "backtest" }).catch((e) => (console.log("corroborate:", e.message), { searched: 0, results: 0, undated: 0, added: 0 }));
signals = read<Signal[]>("signals_backtest");
const cands = resolve(signals, []);
const shortlist = cands.filter((c) => c.gate.pass);

const key = answerKey();
const keyByDomain = new Map(key.filter((k) => k.domain).map((k) => [cleanDomain(k.domain)!, k]));
const keyByName = new Map(key.map((k) => [normName(k.name)!, k]));
// Shortlist companies outside the sampled key may still have announced: one batched domain lookup, billed per hit.
const lookedUp = new Set(read<string[]>("backtest_domains_checked", []));
const toCheck = [...new Set(cands.flatMap((c) => c.domains))].filter((d) => !keyByDomain.has(d) && !lookedUp.has(d));
const extra = [...read<FundableCo[]>("backtest_extra", []), ...fundableByDomains(toCheck)];
write("backtest_extra", extra);
if (!monidState.fundableBlocked) write("backtest_domains_checked", [...lookedUp, ...toCheck]); // a blocked lookup checked nothing
const SEEDISH = /SEED/;
for (const co of extra) if (co.latest_deal && SEEDISH.test(co.latest_deal.type) && Date.parse(co.latest_deal.date) > cutoff.getTime() && co.domain) keyByDomain.set(cleanDomain(co.domain)!, co);

// A hit needs a matching website. A shared name alone is not a hit: the first run "caught" a company that was really three different Marbles.
const matchOf = (c: (typeof cands)[number]) => c.domains.map((d) => keyByDomain.get(d)).find(Boolean);
const nameOnly = cands.filter((c) => !matchOf(c) && keyByName.has(normName(c.name) ?? "")).map((c) => ({ candidate: c.name, candidate_domains: c.domains, key_company: keyByName.get(normName(c.name)!)!.name, key_domain: keyByName.get(normName(c.name)!)!.domain }));
const hitsOf = (list: typeof cands) => list.map((c) => ({ c, k: matchOf(c) })).filter((x) => x.k && x.c.first_seen).map(({ c, k }) => ({
  company: k!.name, domain: k!.domain, round: `${k!.latest_deal!.pre ? "PRE_" : ""}${k!.latest_deal!.type}`, announced: k!.latest_deal!.date.slice(0, 10), first_signal: c.first_seen!.slice(0, 10),
  lead_days: Math.round((Date.parse(k!.latest_deal!.date) - Date.parse(c.first_seen!)) / DAY), signal_families: c.sources, evidence: c.signal_ids.map((id) => signals.find((s) => s.id === id)?.url),
}));
const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)] : null);
const hits = hitsOf(shortlist);
const poolHits = hitsOf(cands);
const keyHit = (list: ReturnType<typeof hitsOf>) => new Set(list.filter((h) => key.some((k) => k.name === h.company)).map((h) => h.company)).size;

const result = {
  cutoff: iso(cutoff), window: `${iso(windowStart)} to ${iso(cutoff)}`, ran_at: now.toISOString(),
  answer_key: { source: "Monid Fundable /companies, latest deal pre-seed or seed in AI, announced after cutoff", size: key.length, note: `Sample of up to ${Math.min(100, Math.ceil(KEY_ROWS / 3))} rounds from each 30-day window after the cutoff, so recall is against a sample, not every round.` },
  shortlist: { size: shortlist.length, hits: hits.length, recall: key.length ? +(keyHit(hits) / key.length).toFixed(3) : null, precision_lower_bound: shortlist.length ? +(hits.length / shortlist.length).toFixed(3) : null, median_lead_days: median(hits.map((h) => h.lead_days)), companies: hits },
  ungated_pool: { size: cands.length, hits: poolHits.length, recall: key.length ? +(keyHit(poolHits) / key.length).toFixed(3) : null, precision_lower_bound: cands.length ? +(poolHits.length / cands.length).toFixed(3) : null, median_lead_days: median(poolHits.map((h) => h.lead_days)), companies: poolHits },
  dating: { telem_results: telemTotal + corr.results, telem_undated_dropped: undated + corr.undated, telem_outside_window_dropped: afterCutoff, github_note: process.env.BACKTEST_GH_NOTE ?? "", self_dated_sources: "Form D file_date, GitHub starred_at, HN created_at" },
  signals_used: signals.length,
  name_only_matches_not_counted: nameOnly,
  funding_lookup: { domains_checked: read<string[]>("backtest_domains_checked", []).length, note: monidState.fundableBlocked ? "Monid blocked some lookups (workspace budget), so not every surfaced website was checked." : "Every surfaced website outside the answer-key sample was checked against Monid Fundable for a pre-seed or seed round after the cutoff." },
};
write("backtest", result);
const done = endRun(run, { signals: signals.length, shortlist: shortlist.length, hits: hits.length, key: key.length });
console.log(JSON.stringify({ ...result, shortlist: { ...result.shortlist, companies: hits.map((h) => `${h.company} (${h.lead_days}d)`) }, ungated_pool: { ...result.ungated_pool, companies: poolHits.map((h) => `${h.company} (${h.lead_days}d)`) } }, null, 1));
console.log(`backtest run cost: $${done.usd} ${JSON.stringify(done.by_tool)}`);
