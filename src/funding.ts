// Funding-range gate. One routed Telem search per company, read by the small model, cached per company.
// Replaces a funding-database lookup that was unavailable and that missed companies by website.
// A company leaves the digest when the web shows a Series A or later, more than MAX_TOTAL_M raised in total,
// or a reported valuation above MAX_VALUATION_M. Nothing found is recorded as "no public record", not as proof.
import { z } from "zod";
import { structured, pool, EXTRACT_MODEL } from "./claude.ts";
import { read, write, type Candidate, type Signal } from "./store.ts";
import { telemSearch } from "./sources/telemIngest.ts";

export const MAX_TOTAL_M = Number(process.env.MAX_TOTAL_RAISED_M ?? 10);
export const MAX_VALUATION_M = Number(process.env.MAX_VALUATION_M ?? 50);

export type Funding = { checked_at: string; found: boolean; total_m: number | null; stage: string | null; latest: string | null; valuation_m: number | null; quote: string | null; url: string | null; out_of_range: boolean; why: string | null };
const Out = z.object({
  same_company: z.boolean().describe("true only if a result is clearly about this exact company: same website, or same product and people. A different company that shares the name is false."),
  total_raised_usd_millions: z.number().nullable().describe("Total venture funding raised to date, in millions of US dollars, as stated in a result about this company. null if not stated."),
  latest_stage: z.enum(["accelerator", "pre_seed", "seed", "series_a", "series_b_or_later", "unknown"]),
  latest_round: z.string().nullable().describe("Latest round as stated: amount, stage, month and year, lead investor. null if none."),
  valuation_usd_millions: z.number().nullable().describe("Reported valuation in millions of US dollars. null if not reported."),
  quote: z.string().nullable().describe("The exact words from one result that support the figures, at most 200 characters."),
  url: z.string().nullable().describe("url of that result, copied exactly"),
});
const SYSTEM = `You read web search results to find how much venture funding one specific early-stage company has raised.
Many startups share a name. Use a result only if it is clearly about the target company (same website, or the same product and people). If results are about a different company with the same name, set same_company false and leave the figures null.
Revenue, ARR, grants, customer contract values and the amounts raised by a company's investors or customers are not funding. Report what a result states; never estimate.`;

export async function checkFunding(cands: Candidate[], signals: Signal[]): Promise<Record<string, Funding>> {
  const cache = read<Record<string, Funding>>("funding_checks", {});
  const byId = new Map(signals.map((s) => [s.id, s]));
  const todo = cands.filter((c) => !cache[c.id] && c.name.length >= 3);
  await pool(todo, 8, async (c) => {
    const rs = await telemSearch(`${c.name}${c.domains[0] ? " " + c.domains[0] : ""} funding raised seed Series A valuation`, { num: 6, op: "funding_check" });
    const ev = [...new Map(rs.map((r) => [r.url, r])).values()].slice(0, 10).map((r) => ({ url: r.url, text: `${r.title}. ${r.summary ?? ""} ${r.excerpt ?? ""}`.slice(0, 700) }));
    const known = c.signal_ids.map((id) => byId.get(id)).find((x) => x?.raw);
    const blank: Funding = { checked_at: new Date().toISOString(), found: false, total_m: null, stage: null, latest: null, valuation_m: null, quote: null, url: null, out_of_range: false, why: null };
    if (!ev.length) { cache[c.id] = blank; return; }
    const out = await structured({ schema: Out, system: SYSTEM, effort: "low", op: "funding_check", model: EXTRACT_MODEL, maxTokens: 2500, user: `Target company: ${c.name}${c.domains[0] ? ` (website ${c.domains[0]})` : ""}${c.location?.place ? `, ${c.location.place}` : ""}. What it does: ${(known?.raw ?? "").slice(0, 300)}\n\nSearch results:\n${ev.map((e, i) => `(${i + 1}) url=${e.url}\n${e.text}`).join("\n\n")}` });
    if (!out) return; // not cached: retried on the next run
    const grounded = out.same_company && !!out.quote && ev.some((e) => e.url === out.url);
    if (!grounded) { cache[c.id] = blank; return; }
    const late = out.latest_stage === "series_a" || out.latest_stage === "series_b_or_later";
    const tooMuch = (out.total_raised_usd_millions ?? 0) > MAX_TOTAL_M;
    const tooRich = (out.valuation_usd_millions ?? 0) > MAX_VALUATION_M;
    cache[c.id] = {
      checked_at: blank.checked_at, found: true, total_m: out.total_raised_usd_millions, stage: out.latest_stage, latest: out.latest_round, valuation_m: out.valuation_usd_millions, quote: out.quote, url: out.url,
      out_of_range: late || tooMuch || tooRich,
      why: late ? "Series A or later" : tooMuch ? `raised over $${MAX_TOTAL_M}M` : tooRich ? `valuation over $${MAX_VALUATION_M}M` : null,
    };
  });
  write("funding_checks", cache);
  return cache;
}
