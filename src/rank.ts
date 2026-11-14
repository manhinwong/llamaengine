import type { Candidate, Score, Feedback } from "./store.ts";

// Demo personas. Weights are illustrative, not anyone's real preferences.
// dimWeights (optional) are a user's own rubric weights, summing to 100; without them the precomputed interval is used.
export type Persona = { name: string; blurb: string; weights: Record<string, number>; dimWeights?: Record<string, number> };
export const PERSONAS: Record<string, Persona> = {
  A: { name: "Investor A", blurb: "Robotics and hardware, research lineage", weights: { "sector:robotics": 0.8, "sector:hardware": 0.6, "sector:software_for_hardware": 0.5, "signal:paper": 0.4, "signal:lab_roster_change": 0.4, "signal:form_d": 0.2, "dim:founder_market_fit": 0.5, "sector:ai_app": -0.3 } },
  B: { name: "Investor B", blurb: "AI infrastructure and developer tools, open-source pull", weights: { "sector:ai_infra": 0.8, "sector:dev_tools": 0.7, "signal:star_velocity": 0.5, "signal:show_hn": 0.4, "dim:tech_traction": 0.5, "sector:robotics": -0.2, "sector:hardware": -0.3 } },
  C: { name: "Investor C", blurb: "Verification and security for AI agents and AI-written code", weights: { "sector:security": 4.5, "tag:proves_by_running": 0.8, "tag:agent_runtime_controls": 0.6, "tag:code_verification": 0.6, "tag:works_across_agents": 0.4, "tag:open_source": 0.4, "dim:tech_traction": 0.4, "dim:founder_market_fit": 0.4, "sector:robotics": -0.4, "sector:hardware": -0.4, "sector:ai_app": -0.3 } },
};
// `dims` limits which rubric dimensions a reason may move. A verdict on the founder moves the founder dimensions only,
// never product or traction ones the same company happened to score well on.
const FOUNDER_DIMS = ["identity", "founder_market_fit", "ambition"];
export const REASONS: Record<string, { label: string; groups: string[]; dims?: string[] }> = {
  love_space: { label: "Love the space", groups: ["sector", "tag"] },
  love_founder: { label: "Love the founder", groups: ["dim", "seed"], dims: FOUNDER_DIMS },
  wrong_sector: { label: "Wrong sector", groups: ["sector", "tag"] },
  too_late: { label: "Too late", groups: ["signal"] },
  weak_founder_fit: { label: "Weak founder fit", groups: ["dim", "seed"], dims: FOUNDER_DIMS },
  not_ai_native: { label: "Not AI-native", groups: ["sector"] },
  note: { label: "In my own words", groups: ["sector", "tag", "signal", "dim", "seed"] },
};

// A typed reason is read by keyword, in the browser, with no model call. Each topic it mentions decides which of the
// company's features the vote moves. A note that mentions none of them moves everything a little, like a bare vote.
const NOTE_TOPICS: { re: RegExp; groups: string[]; dims?: string[] }[] = [
  { re: /founder|team|ceo|cto|background|experience|pedigree|operator|track record/i, groups: ["dim", "seed"], dims: FOUNDER_DIMS },
  { re: /space|market|sector|category|industry|thesis|timing|trend|tailwind/i, groups: ["sector", "tag"] },
  { re: /product|demo|ux|design|user|customer love|works well/i, groups: ["dim"], dims: ["product_value"] },
  { re: /traction|customer|revenue|arr|growth|adoption|pilot|contract|sales|distribution|gtm/i, groups: ["dim"], dims: ["gtm_traction"] },
  { re: /tech|technical|research|paper|open.?source|oss|benchmark|github|model|engineering|ip\b|patent|hardware/i, groups: ["dim", "tag"], dims: ["tech_traction"] },
  { re: /signal|early|stealth|first hire|hiring|launch/i, groups: ["signal"] },
];
export function noteTargets(note: string) {
  const hits = NOTE_TOPICS.filter((t) => t.re.test(note));
  if (!hits.length) return { groups: REASONS.note.groups, dims: undefined as string[] | undefined, matched: false };
  const dims = hits.flatMap((t) => t.dims ?? []);
  return { groups: [...new Set(hits.flatMap((t) => t.groups))], dims: dims.length ? [...new Set(dims)] : undefined, matched: true };
}
const STEP = 0.25, CAP = 1, POINTS = 5; // one unit of weight on a fully-present feature moves a candidate 5 points
const OWN_VOTE = 6; // an explicit vote also moves that one company directly
const STANDOUT = 8; // points per level above 3 on a company's best dimension

export function features(c: Candidate, s?: Score): Record<string, number> {
  const f: Record<string, number> = { [`sector:${c.sector}`]: 1 };
  for (const t of c.signal_types) f[`signal:${t}`] = 1;
  for (const t of c.tags ?? []) f[`tag:${t}`] = 1;
  if (c.seed_hit) f["seed:seed_person"] = 1;
  for (const [k, d] of Object.entries(s?.dims ?? {})) if (typeof d.level === "number") f[`dim:${k}`] = (d.level - 1) / 4;
  return f;
}

// Weights are recomputed from raw feedback events every time; events are never overwritten.
export function personaWeights(investor: string, feedback: Feedback[], cands: Map<string, Candidate>, scores: Map<string, Score>) {
  const w = { ...(PERSONAS[investor]?.weights ?? {}) };
  for (const ev of feedback.filter((e) => e.investor === investor)) {
    const c = cands.get(ev.candidate_id);
    if (!c) continue;
    const typed = ev.reason === "note" && ev.note ? noteTargets(ev.note) : null;
    const groups = typed?.groups ?? REASONS[ev.reason]?.groups ?? ["sector", "tag", "signal", "dim", "seed"];
    for (const [k, x] of Object.entries(features(c, scores.get(c.id)))) {
      if (!groups.includes(k.split(":")[0])) continue;
      const only = typed ? typed.dims : REASONS[ev.reason]?.dims;
      if (only && k.startsWith("dim:") && !only.includes(k.slice(4))) continue;
      const cap = Math.max(CAP, Math.abs(PERSONAS[investor]?.weights[k] ?? 0)); // a strong starting preference is not clipped by the first vote
      w[k] = Math.max(-cap, Math.min(cap, (w[k] ?? 0) + ev.vote * STEP * (x || 1)));
    }
  }
  return w;
}

// Same interval rule as the scorer: P = points on assessed dimensions, C = assessed weight, lower = P + (100 - C) / 5. Never normalized.
export function intervalFor(s: Score, dimWeights?: Record<string, number>): Score {
  if (!dimWeights) return s;
  const total = Object.values(dimWeights).reduce((a, b) => a + b, 0) || 1;
  let P = 0, C = 0;
  for (const [k, d] of Object.entries(s.dims)) {
    const w = ((dimWeights[k] ?? 0) / total) * 100;
    if (typeof d.level === "number") { P += (w * d.level) / 5; C += w; }
  }
  return { ...s, P: +P.toFixed(1), C: +C.toFixed(1), lower: +(P + (100 - C) / 5).toFixed(1), upper: +(P + (100 - C)).toFixed(1) };
}

export function rank(investor: string, cands: Candidate[], scores: Score[], feedback: Feedback[]) {
  const cm = new Map(cands.map((c) => [c.id, c]));
  const dw = PERSONAS[investor]?.dimWeights;
  const sm = new Map(scores.map((s) => [s.candidate_id, intervalFor(s, dw)]));
  const w = personaWeights(investor, feedback, cm, sm);
  return cands
    .filter((c) => c.status === "digest" && sm.has(c.id))
    .map((c) => {
      const s = sm.get(c.id)!;
      const contrib = Object.entries(features(c, s)).map(([k, x]) => ({ feature: k, points: +((w[k] ?? 0) * x * POINTS).toFixed(2) })).filter((x) => x.points !== 0);
      // Standout bonus: one clear peak beats an even, average profile. Most dimensions are unknown before contact,
      // so a single level 4 or 5 is the better reason to take a call and fill in the rest. Worth half when only the
      // founder's own claims back it. Ambition is excluded: it is scored from what a company says about itself.
      const peak = Object.entries(s.dims).filter(([k, d]) => k !== "ambition" && typeof d.level === "number" && (d.level as number) >= 4).sort((a, b) => (b[1].level as number) - (a[1].level as number) || Number(b[1].claims.some((x) => x.label === "V")) - Number(a[1].claims.some((x) => x.label === "V")))[0];
      if (peak) contrib.push({ feature: `standout:${peak[0]}`, points: +(((peak[1].level as number) - 3) * STANDOUT * (peak[1].claims.some((x) => x.label === "V") ? 1 : 0.5)).toFixed(2) });
      const last = feedback.filter((e) => e.investor === investor && e.candidate_id === c.id).slice(-1)[0];
      if (last) contrib.push({ feature: last.vote > 0 ? "your thumbs up" : "your thumbs down", points: last.vote * OWN_VOTE });
      const fit = contrib.reduce((a, b) => a + b.points, 0);
      const why = [{ feature: "lower bound", points: s.lower }, ...contrib.sort((a, b) => Math.abs(b.points) - Math.abs(a.points))].slice(0, 3);
      return { candidate: c, score: s, fit: +fit.toFixed(2), rank_score: +(s.lower + fit).toFixed(2), why, voted: feedback.filter((e) => e.investor === investor && e.candidate_id === c.id).slice(-1)[0] ?? null };
    })
    .sort((a, b) => b.rank_score - a.rank_score)
    .slice(0, 15);
}

// What an investor's feedback has taught the engine: learned weight minus the persona's starting weight, per feature.
export function learned(investor: string, cands: Candidate[], scores: Score[], feedback: Feedback[]) {
  const base = PERSONAS[investor]?.weights ?? {};
  const w = personaWeights(investor, feedback, new Map(cands.map((c) => [c.id, c])), new Map(scores.map((s) => [s.candidate_id, s])));
  return Object.keys({ ...base, ...w })
    .map((k) => ({ feature: k, start: base[k] ?? 0, now: +(w[k] ?? 0).toFixed(2), delta: +((w[k] ?? 0) - (base[k] ?? 0)).toFixed(2), points: +(((w[k] ?? 0) - (base[k] ?? 0)) * POINTS).toFixed(2) }))
    .filter((x) => x.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

// How two investors' top lists diverge as feedback accumulates. Replays the append-only events in time order;
// at each event, both rankings are recomputed from the events up to that moment.
export function compare(a: string, b: string, cands: Candidate[], scores: Score[], feedback: Feedback[], k = 15) {
  const evs = feedback.filter((e) => e.investor === a || e.investor === b).sort((x, y) => String(x.at).localeCompare(String(y.at)));
  const top = (inv: string, upTo: Feedback[]) => rank(inv, cands, scores, upTo).slice(0, k).map((r) => r.candidate.id);
  const point = (upTo: Feedback[], at: string | null) => {
    const ta = top(a, upTo), tb = top(b, upTo);
    const shared = ta.filter((id) => tb.includes(id));
    return { at, events: upTo.length, shared: shared.length, of: Math.min(k, Math.max(ta.length, tb.length)), overlap: ta.length && tb.length ? +(shared.length / Math.min(k, Math.max(ta.length, tb.length))).toFixed(2) : null, top_a: ta, top_b: tb, shared_ids: shared };
  };
  const series = [point([], null)];
  for (let i = 0; i < evs.length; i++) series.push(point(evs.slice(0, i + 1), evs[i].at));
  return series;
}
