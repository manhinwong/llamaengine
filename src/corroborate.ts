import { read, write, addSignals, type Candidate, type Signal } from "./store.ts";
import { telemSearch } from "./sources/telemIngest.ts";
import { extract } from "./extract.ts";
import { pool } from "./claude.ts";
import type { RawItem } from "./sources/edgar.ts";

const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const iso = (d: Date) => d.toISOString().slice(0, 10);

// A single-signal company gets one routed Telem search for a second, independent signal.
// Results from a host that already produced a signal for it do not count. Each company is searched once.
// With `before`, only results with a publish date on or before that day are kept (backtest); undated ones are dropped and counted.
export async function corroborate(cands: Candidate[], signals: Signal[], opts: { table?: string; before?: Date; after?: Date; max?: number; run?: "live" | "backtest" } = {}) {
  const table = opts.table ?? "signals";
  const doneKey = `corroborated_${table}`;
  const done = new Set(read<string[]>(doneKey, []));
  const byId = new Map(signals.map((s) => [s.id, s]));
  // Sectors named in CORROBORATE_FIRST go to the front of the queue, so a new focus area is not starved by the per-run limit.
  const first = (process.env.CORROBORATE_FIRST ?? "security").split(",");
  const todo = cands.filter((c) => !c.gate.pass && !done.has(c.id) && c.name.length >= 4).sort((a, b) => Number(first.includes(b.sector)) - Number(first.includes(a.sector))).slice(0, opts.max ?? 90);
  const raw: RawItem[] = [];
  let undated = 0, total = 0;
  await pool(todo, 6, async (c) => {
    const seenHosts = new Set(c.signal_ids.map((id) => hostOf(byId.get(id)?.url ?? "")));
    const q = `${c.name}${c.domains[0] ? " " + c.domains[0] : ""} ${c.sector.replace(/_/g, " ")} startup founders`;
    const rs = await telemSearch(q, { num: 6, op: "corroborate", ...(opts.before ? { published_before: iso(opts.before) } : {}), ...(opts.after ? { published_after: iso(opts.after) } : {}) });
    const first = c.signal_ids.map((id) => byId.get(id)).find((x) => x?.raw);
    const context = `Target company: "${c.name}"${c.domains[0] ? `, website ${c.domains[0]}` : ""}${c.people.length ? `, people: ${c.people.slice(0, 4).join(", ")}` : ""}. Known from ${first?.url ?? "its first signal"}: ${(first?.raw ?? "").slice(0, 400)}`;
    const uniq = [...new Map(rs.map((r) => [r.url, r])).values()].slice(0, opts.before ? 12 : 6);
    for (const r of uniq) {
      total++;
      if (seenHosts.has(hostOf(r.url))) continue;
      const t = r.publish_date ? Date.parse(r.publish_date) : NaN;
      if (opts.before) {
        if (Number.isNaN(t)) { undated++; continue; }
        if (t > opts.before.getTime()) continue;
      }
      raw.push({ source: "telem_search", signal_type: "web_mention", url: r.url, title: r.title, text: `${context}\n---\nSearch result to judge: ${r.title}. ${r.summary ?? ""} ${r.excerpt ?? ""}`.slice(0, 2200), date: Number.isNaN(t) ? null : new Date(t).toISOString(), label: "F", hint: { company: c.name } });
    }
    done.add(c.id);
  });
  const known = new Set(signals.map((s) => s.url));
  const added = addSignals(await extract(raw.filter((r) => !known.has(r.url)), opts.run ?? "live"), table);
  write(doneKey, [...done]);
  console.log(`  corroboration: ${todo.length} companies searched, ${total} results, ${raw.length} kept, ${added} signals added${opts.before ? `, ${undated} undated dropped` : ""}`);
  return { searched: todo.length, results: total, undated, added };
}
