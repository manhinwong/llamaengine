// v2 gate applied to the stored candidates, in place. Phases, run separately so each paid step is visible:
//   npx tsx src/v2.ts gate    merge lookup records, apply the strict gate, sort companies into verified / early, run the
//                             free check on new passers (a round stated in their own signals) and the location check
//   npx tsx src/v2.ts akta    Akta funding check (via Monid) on the verified digest, cached 7 days including "not found"
//   npx tsx src/v2.ts score   rubric scores for verified digest companies that have none
// Candidates are never re-resolved here, so ids and earlier decisions (raised, not US) are kept.
import { execFileSync } from "node:child_process";
import "./env.ts";
import { read, write, startRun, endRun, type Candidate, type Signal, type Score } from "./store.ts";
import { gateV2, hardLinked, widelySeen } from "./tiers.ts";
import { applyStatedRoundGate } from "./gates.ts";
import { MAX_TOTAL_M } from "./funding.ts";
import { logSpend } from "./telem.ts";

type Found = Signal & { name_only: boolean; lookup: string };
const OUT = new Set(["already_raised", "not_us"]);
const STRONG = new Set(["left_job", "launch_post", "hiring", "linkedin_post", "x_post", "producthunt"]);
const days = (d?: string | null) => (d ? (Date.now() - Date.parse(d)) / 864e5 : Infinity);

// Signal strength for the early lane: how many records, how credible, how recent. Not the rubric.
export function strength(c: Candidate, sigs: Signal[]) {
  const g = gateV2(sigs, c);
  const why: string[] = [];
  let pts = 0;
  for (const fam of g.primary) {
    const linked = g.tiers.some((x) => x.family === fam && x.tier === "primary" && hardLinked(x.s, c));
    pts += linked ? 3 : 1.5;
    why.push(`${fam}${linked ? "" : " (matched by name)"}`);
  }
  if (g.hasThird) { pts += 2; why.push("third-party post"); }
  const strong = [...new Set(sigs.filter((s) => STRONG.has(s.signal_type) && s.is_startup !== false).map((s) => s.signal_type))];
  if (strong.length) { pts += Math.min(2, strong.length); why.push(...strong.slice(0, 2)); }
  const newest = Math.min(...sigs.map((s) => days(s.date)));
  if (newest <= 30) { pts += 1; why.push("seen in the last 30 days"); } else if (newest <= 90) pts += 0.5;
  if (c.seed_hit) { pts += 2; why.push("seed-list person"); }
  return { points: +pts.toFixed(1), why };
}

async function gate() {
  const cands = read<Candidate[]>("candidates");
  const signals = read<Signal[]>("signals");
  const lookup = read<Record<string, { found: Found[] }>>("primary_lookup", {});
  const have = new Set(signals.map((s) => s.id));
  let merged = 0;
  for (const c of cands) for (const f of lookup[c.id]?.found ?? []) {
    if (f.name_only) continue; // a record matched on name alone is never merged
    if (!have.has(f.id)) { signals.push(f); have.add(f.id); merged++; }
    if (!c.signal_ids.includes(f.id)) c.signal_ids.push(f.id);
    if (f.github && !c.github.includes(f.github)) c.github.push(f.github);
  }
  write("signals", signals);
  const byId = new Map(signals.map((s) => [s.id, s]));
  const sigsOf = (c: Candidate) => c.signal_ids.map((id) => byId.get(id)).filter(Boolean) as Signal[];
  const fresh: Candidate[] = [];
  const moved: Record<string, number> = {};
  for (const c of cands as any[]) {
    const sigs = sigsOf(c);
    const g = gateV2(sigs, c);
    c.gate2 = { pass: g.pass, pair: g.pair, reason: g.reason };
    c.widely_seen = widelySeen(sigs, c);
    c.strength = strength(c, sigs);
    const was = c.status;
    if (g.pass) {
      if (was === "gated_out" || was === "early") { c.status = "digest"; fresh.push(c); }
      else if (was === "location_unconfirmed") fresh.push(c);
    } else if (!OUT.has(was)) {
      const early = c.sector !== "other" && (g.primary.length >= 1 || sigs.some((s) => STRONG.has(s.signal_type) && s.is_startup !== false));
      c.status = early ? "early" : "gated_out";
    }
    if (was !== c.status) moved[`${was} -> ${c.status}`] = (moved[`${was} -> ${c.status}`] ?? 0) + 1;
  }
  console.log(`lookup records merged: ${merged}`, moved);
  // Free check on the new passers only: a round stated in their own signals.
  const newDigest = fresh.filter((c) => c.status === "digest");
  console.log(`new passers: ${newDigest.length} never checked, ${fresh.length - newDigest.length} with no confirmed location`);
  console.log(`  stated round: ${applyStatedRoundGate(newDigest, signals)} out`);
  // Location: the companies' own sources only. LOCATE_NO_SEARCH keeps this step off paid search.
  process.env.LOCATE_NO_SEARCH = "1";
  const { locate } = await import("./locate.ts");
  const toLocate = fresh.filter((c) => c.status === "digest" || c.status === "location_unconfirmed");
  const loc = await locate(toLocate, signals);
  for (const c of toLocate) {
    const l = loc[c.id];
    c.location = l ? { country: l.country, us: l.us, place: l.place, quote: l.quote, url: l.url } : null;
    c.status = l?.us === true ? "digest" : l?.us === false ? "not_us" : "location_unconfirmed";
  }
  console.log(`  location: US ${toLocate.filter((c) => c.status === "digest").length}, not US ${toLocate.filter((c) => c.status === "not_us").length}, not stated ${toLocate.filter((c) => c.status === "location_unconfirmed").length}`);
  write("candidates", cands);
  const n = (s: string) => cands.filter((c) => c.status === s).length;
  console.log(`verified digest ${n("digest")}, early lane ${n("early")}, already raised ${n("already_raised")}, not US ${n("not_us")}, location not stated ${n("location_unconfirmed")}, out ${n("gated_out")}`);
  return { digest: n("digest"), early: n("early"), merged };
}

// Free location evidence for verified companies whose sources state none: the location on their GitHub profile.
// It is added to the GitHub record's text, then the normal location check decides (it still needs a quote and a link).
async function ghloc() {
  const cands = read<Candidate[]>("candidates");
  const signals = read<Signal[]>("signals");
  const byId = new Map(signals.map((s) => [s.id, s]));
  const cache = read<Record<string, unknown>>("locations", {});
  const todo = (cands as any[]).filter((c) => c.status === "location_unconfirmed" && c.gate2?.pass && c.github.length);
  const headers: Record<string, string> = process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
  const touched: Candidate[] = [];
  for (const c of todo) {
    for (const h of c.github as string[]) {
      const r = await fetch(`https://api.github.com/users/${h}`, { headers }).catch(() => null);
      const loc = r?.ok ? (await r.json()).location : null;
      const sig = c.signal_ids.map((id: string) => byId.get(id)).find((s: Signal | undefined) => s && /github/.test(s.source) && s.url.toLowerCase().includes(h));
      if (!loc || !sig || /GitHub profile location/.test(sig.raw ?? "")) continue;
      sig.raw = `${sig.raw ?? sig.text} GitHub profile location: ${loc}.`;
      delete cache[c.id];
      touched.push(c);
      break;
    }
  }
  write("signals", signals);
  write("locations", cache);
  process.env.LOCATE_NO_SEARCH = "1";
  const { locate } = await import("./locate.ts");
  const loc = await locate(touched, signals);
  for (const c of touched) {
    const l = loc[c.id];
    c.location = l ? { country: l.country, us: l.us, place: l.place, quote: l.quote, url: l.url } : null;
    c.status = l?.us === true ? "digest" : l?.us === false ? "not_us" : "location_unconfirmed";
  }
  write("candidates", cands);
  console.log(`github profile location: ${todo.length} checked, ${touched.length} had one; now US ${touched.filter((c) => c.status === "digest").length}, not US ${touched.filter((c) => c.status === "not_us").length}, still not stated ${touched.filter((c) => c.status === "location_unconfirmed").length}`);
  console.log(touched.map((c) => `${c.name}: ${c.location?.place ?? c.location?.country ?? "?"} -> ${c.status}`).join("; "));
  return { located: touched.length };
}

type Akta = { checked_at: string; found: boolean; stage: string | null; total_usd: number | null; last_date: string | null; rounds: string[]; investors?: string[]; raw?: unknown };
const AKTA_TTL_DAYS = 7;
const LATE = /series[\s_-]*[a-k]\b|growth|late stage|ipo|public|private equity/i;
function aktaCall(domain: string): Akta {
  let raw: string;
  // The CLI exits non-zero on a provider 404 ("company not found") but still prints the run as JSON.
  try { raw = execFileSync("monid", ["run", "-p", "akta", "-e", "/v1/company/enrichment/funding_detail/{company}", "--path", JSON.stringify({ company: domain }), "-w", "120", "-j"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e: any) { raw = String(e.stdout ?? ""); if (!raw.trim().startsWith("{")) throw new Error(`monid run failed: ${String(e.stderr ?? e.message).slice(0, 160)}`); }
  const j = JSON.parse(raw);
  if (j.status === "BLOCKED") throw new Error(`monid blocked: ${String(j.reason).slice(0, 160)}`);
  const usd = (j.billing?.reportedCost?.value ?? 0) / 1e6 || (j.billedUnits ? 0.15 * j.billedUnits : 0);
  logSpend("monid", "akta_funding", usd, `akta funding_detail ${domain} http=${j.providerResponse?.httpStatus ?? 200}`);
  const d = j.output?.data ?? j.output ?? null;
  if (!d || j.providerResponse?.httpStatus === 404) return { checked_at: new Date().toISOString(), found: false, stage: null, total_usd: null, last_date: null, rounds: [] };
  const o = d.funding_detail?.funding_overview ?? {};
  const ym = (x: any) => (x?.year ? `${x.year}-${String(x.month ?? 1).padStart(2, "0")}` : null);
  return {
    checked_at: new Date().toISOString(), found: true,
    stage: o.funding_stage?.label ?? null, total_usd: typeof o.total_funding_usd === "number" ? o.total_funding_usd : null, last_date: ym(o.last_funding_date),
    rounds: (d.funding_detail?.funding_rounds ?? []).slice(0, 6).map((r: any) => [r.round?.label, ym(r.date)].filter(Boolean).join(" ")),
    investors: (d.funding_detail?.investors ?? []).slice(0, 6).map((x: any) => x.name).filter(Boolean), raw: d,
  } as Akta;
}
const aktaOut = (a: Akta) => {
  if (!a.found) return null;
  const late = [a.stage ?? "", ...a.rounds].find((x) => LATE.test(x));
  if (late) return `${late.trim().slice(0, 40)} per Akta`;
  if (a.total_usd != null && a.total_usd > MAX_TOTAL_M * 1e6) return `$${(a.total_usd / 1e6).toFixed(1)}M raised per Akta, over the $${MAX_TOTAL_M}M limit`;
  return null;
};

async function akta() {
  const cands = read<Candidate[]>("candidates");
  const cache = read<Record<string, Akta>>("akta_funding", {});
  const live = cands.filter((c) => c.status === "digest");
  const withSite = live.filter((c) => c.domains[0]);
  const fresh = (d: string) => cache[d] && (Date.now() - Date.parse(cache[d].checked_at)) / 864e5 < AKTA_TTL_DAYS;
  const max = Number(process.argv[3] ?? Infinity);
  let calls = 0, shown = false;
  for (const c of withSite) {
    const d = c.domains[0];
    if (fresh(d) || calls >= max) continue;
    try { cache[d] = aktaCall(d); calls++; }
    catch (e: any) { console.log(`  ${c.name}: ${e.message.slice(0, 160)}`); break; }
    if (cache[d].found && !shown) { shown = true; console.log(`first record found (${c.name}):`, JSON.stringify(cache[d].raw).slice(0, 900)); }
    write("akta_funding", cache);
  }
  let out = 0, inRange = 0, none = 0;
  for (const c of withSite) {
    const a = cache[c.domains[0]];
    if (!a) continue;
    if (!a.found) { none++; continue; }
    const why = aktaOut(a);
    const label = [a.stage, a.total_usd != null ? `$${a.total_usd >= 1e6 ? (a.total_usd / 1e6).toFixed(1) + "M" : Math.round(a.total_usd / 1e3) + "K"} raised` : null, a.last_date, a.investors?.length ? `investors: ${a.investors.slice(0, 3).join(", ")}` : null].filter(Boolean).join(", ");
    if (why) { c.status = "already_raised"; c.raised = { round: `${label} (${why})`.slice(0, 120), date: a.last_date, source: "Akta via Monid" }; out++; }
    else { inRange++; if (!c.raised && label) c.raised = { round: label.slice(0, 90), date: a.last_date, source: "Akta via Monid" }; }
  }
  write("candidates", cands);
  console.log(`akta: ${withSite.length} with a website (${live.length - withSite.length} without, not checked), ${calls} calls this run, ${none} not in Akta, ${inRange} in range, ${out} out of range`);
  return { calls, out, in_range: inRange, not_found: none };
}

async function score() {
  const cands = read<Candidate[]>("candidates");
  const signals = read<Signal[]>("signals");
  const prev = new Map(read<Score[]>("scores").map((s) => [s.candidate_id, s]));
  const todo = cands.filter((c) => c.status === "digest" && !prev.has(c.id));
  console.log(`unscored verified companies: ${todo.length}`);
  const { scoreCandidates } = await import("./score.ts");
  const fresh = await scoreCandidates(todo, signals, {});
  for (const s of fresh) prev.set(s.candidate_id, { ...s, n_signals: cands.find((c) => c.id === s.candidate_id)!.signal_ids.length } as any);
  write("scores", [...prev.values()]);
  const { claudeSpend } = await import("./claude.ts");
  console.log(`scored ${fresh.length}; claude this run $${claudeSpend().run}, total $${claudeSpend().total} of $${claudeSpend().total_cap}`);
  return { scored_now: fresh.length };
}

if (process.argv[1]?.endsWith("v2.ts")) {
  const phases: Record<string, () => Promise<Record<string, number>>> = { gate, ghloc, akta, score };
  const kind = process.argv[2];
  if (!phases[kind]) { console.log("usage: v2.ts gate | akta [max calls] | score"); process.exit(1); }
  const run = startRun(`v2_${kind}`);
  try { const done = endRun(run, await phases[kind]()); console.log(`run ${done.id} v2_${kind}: $${done.usd} ${JSON.stringify(done.by_tool)}`); }
  catch (e: any) { endRun(run, {}, "failed"); throw e; }
}
