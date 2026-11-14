// US-only gate. Headquarters country is read from the company's own source texts, with the quote and URL kept.
// Nothing is inferred from a founder's name or background.
import { z } from "zod";
import { structured, pool, EXTRACT_MODEL } from "./claude.ts";
import { read, write, type Candidate, type Signal } from "./store.ts";
import { telemSearch } from "./sources/telemIngest.ts";

export type Location = { country: string | null; us: boolean | null; place: string | null; quote: string | null; url: string | null };
const Out = z.object({
  country: z.string().nullable().describe("Country where the company is headquartered or incorporated, as stated in an evidence item. null if no item states a location for the company itself."),
  place: z.string().nullable().describe("City and state/region as stated, e.g. 'San Francisco, CA'"),
  quote: z.string().nullable().describe("The exact words from the item that state the location, at most 160 characters"),
  url: z.string().nullable().describe("url of the evidence item the quote comes from, copied exactly"),
});
const SYSTEM = `Decide where a company is based, using only the evidence items.
Count: a stated headquarters or office city, a US state of incorporation or business address on an SEC filing, a job posting's office location, "based in ...".
Do not count: where a founder studied or used to work, a founder's nationality or name, the location of an investor, customer, or the publication.
A remote-only job post with no stated company location is not evidence. If nothing states the company's own location, return nulls.`;
const US = /^(us|usa|u\.s\.a?\.?|united states|united states of america)$/i;

export async function locate(cands: Candidate[], signals: Signal[]): Promise<Record<string, Location>> {
  const cache = read<Record<string, Location & { n: number }>>("locations", {});
  const byId = new Map(signals.map((s) => [s.id, s]));
  const todo = cands.filter((c) => !cache[c.id] || cache[c.id].n !== c.signal_ids.length);
  await pool(todo, 8, async (c) => {
    const ev = c.signal_ids.map((id) => byId.get(id)!).filter(Boolean).map((s) => ({ url: s.url, text: `${s.title}. ${s.raw ?? ""}`.slice(0, 1500) }));
    const out = await structured({ schema: Out, system: SYSTEM, effort: "low", op: "locate", model: EXTRACT_MODEL, maxTokens: 1500, user: `Company: ${c.name}${c.domains[0] ? ` (${c.domains[0]})` : ""}\n\n${ev.map((e, i) => `(${i + 1}) url=${e.url}\n${e.text}`).join("\n\n")}` });
    if (!out) return;
    const grounded = !!out.country && !!out.quote && ev.some((e) => e.url === out.url);
    cache[c.id] = { country: grounded ? out.country : null, us: grounded ? US.test(out.country!.trim()) : null, place: grounded ? out.place : null, quote: grounded ? out.quote : null, url: grounded ? out.url : null, n: c.signal_ids.length };
  });
  // Second pass: companies whose own signals state no location get one routed Telem search.
  const unknown = cands.filter((c) => cache[c.id] && cache[c.id].us === null && !(cache[c.id] as any).searched);
  await pool(unknown, 6, async (c) => {
    const rs = await telemSearch(`${c.name}${c.domains[0] ? " " + c.domains[0] : ""} company headquarters location`, { num: 5, op: "locate" });
    const ev = [...new Map(rs.map((r) => [r.url, r])).values()].slice(0, 6).map((r) => ({ url: r.url, text: `${r.title}. ${r.summary ?? ""} ${r.excerpt ?? ""}`.slice(0, 900) }));
    (cache[c.id] as any).searched = true;
    if (!ev.length) return;
    const known = c.signal_ids.map((id) => byId.get(id)).find((x) => x?.raw);
    const out = await structured({ schema: Out, system: SYSTEM + "\nThe items are search results. Use an item only if it is clearly about this same company (same website, product or people), not another company with a similar name.", effort: "low", op: "locate", model: EXTRACT_MODEL, maxTokens: 1500, user: `Company: ${c.name}${c.domains[0] ? ` (${c.domains[0]})` : ""}. What it is: ${(known?.raw ?? "").slice(0, 300)}\n\n${ev.map((e, i) => `(${i + 1}) url=${e.url}\n${e.text}`).join("\n\n")}` });
    if (!out) return;
    const grounded = !!out.country && !!out.quote && ev.some((e) => e.url === out.url);
    if (grounded) cache[c.id] = { country: out.country, us: US.test(out.country!.trim()), place: out.place, quote: out.quote, url: out.url, n: c.signal_ids.length, searched: true } as any;
  });
  write("locations", cache);
  return cache;
}
