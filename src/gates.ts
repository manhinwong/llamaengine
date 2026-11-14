import type { Candidate, Signal } from "./store.ts";
import { fundableByDomains, fundableBlocked } from "./monid.ts";
import { read, write } from "./store.ts";

const PRICED = /SERIES|GROWTH|PRIVATE_EQUITY|IPO|DEBT|SEED/; // any announced round, seed included, means the press release already exists

// Monid: a company with a public round leaves the digest for the "already raised" list.
export function applyRaisedGate(cands: Candidate[]) {
  // Results are cached by website, so a day when Monid is blocked or over budget cannot undo an earlier finding.
  const cache = read<Record<string, { round: string; date: string | null; source: string } | null>>("fundable_cache", {});
  const pass = cands.filter((c) => c.status === "digest" && c.domains.length);
  const unknown = [...new Set(pass.flatMap((c) => c.domains))].filter((d) => !(d in cache));
  const cos = fundableByDomains(unknown);
  if (!fundableBlocked) for (const d of unknown) cache[d] = null; // looked up, no record
  for (const co of cos) {
    const d = co.domain?.toLowerCase().replace(/^www\./, "");
    if (d && co.latest_deal && PRICED.test(co.latest_deal.type)) cache[d] = { round: `${co.latest_deal.pre ? "PRE_" : ""}${co.latest_deal.type}`, date: co.latest_deal.date, source: "Monid / Fundable" };
  }
  write("fundable_cache", cache);
  // Hand-confirmed rounds (data/manual_raised.json, by company name) always apply. Added 2026-11-14 after eight
  // companies with a round stated in their own signals stayed in the digest while the funding lookup was unavailable.
  const manual = read<Record<string, { round: string; date: string | null; source: string }>>("manual_raised", {});
  for (const c of cands.filter((c) => c.status === "digest")) {
    const hit = manual[c.name] ?? c.domains.map((d) => cache[d]).find(Boolean);
    if (hit) { c.status = "already_raised"; c.raised = hit; }
  }
  return cos.length;
}

// Fallback that needs no paid lookup: the signals themselves often state a round ("raised $30M led by ...").
// Series A or later, or a stated round of $8M or more, leaves the pre-seed/seed digest. Smaller stated rounds stay, tagged.
const ROUND = /\$\s?(\d+(?:\.\d+)?)\s?(k|m|mm|million|b|billion)\b[^.\n]{0,60}\b(pre-?seed|seed|series [a-e]|round|funding|financing)|\b(raised|raises|secures?|closes?|closed)\b[^.\n]{0,60}\$\s?(\d+(?:\.\d+)?)\s?(k|m|mm|million|b|billion)\b/i;
const SERIES = /\bseries [a-e]\b/i;
export function applyStatedRoundGate(cands: Candidate[], signals: Signal[]) {
  const byId = new Map(signals.map((s) => [s.id, s]));
  let moved = 0;
  for (const c of cands.filter((c) => c.status === "digest")) {
    for (const id of c.signal_ids) {
      const s = byId.get(id);
      const text = `${s?.title ?? ""} ${s?.raw ?? ""}`;
      const m = text.match(ROUND);
      if (!s || !m) continue;
      const num = Number(m[1] ?? m[5]);
      const unit = (m[2] ?? m[6] ?? "").toLowerCase();
      const usd = num * (unit.startsWith("b") ? 1e9 : unit === "k" ? 1e3 : 1e6);
      const stated = m[0].replace(/\s+/g, " ").slice(0, 80);
      c.raised = { round: stated, date: s.date, source: s.url };
      if (SERIES.test(text) || usd >= 8e6) { c.status = "already_raised"; moved++; }
      break;
    }
  }
  return moved;
}
