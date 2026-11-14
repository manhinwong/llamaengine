// With-Telem vs without-Telem comparison on the same stored signals. No API calls, no spend.
import "./env.ts";
import { read, write, type Signal, type Candidate } from "./store.ts";
import { resolve } from "./resolve.ts";

const isTelem = (s: Signal) => s.source.startsWith("telem");
const summarize = (signals: Signal[]) => {
  const cands = resolve(signals, read<{ name: string }[]>("seeds", []).map((s) => s.name));
  return { signals: signals.length, companies: cands.length, pass_gate: cands.filter((c) => c.gate.pass).length, cands };
};
function compare(table: string) {
  const all = read<Signal[]>(table);
  const withT = summarize(all);
  const without = summarize(all.filter((s) => !isTelem(s)));
  const passWithout = new Set(without.cands.filter((c) => c.gate.pass).map((c) => c.name.toLowerCase()));
  const knownWithout = new Set(without.cands.map((c) => c.name.toLowerCase()));
  const passWith = withT.cands.filter((c) => c.gate.pass);
  const bySource: Record<string, number> = {};
  for (const s of all.filter(isTelem)) bySource[s.source.split(":")[0]] = (bySource[s.source.split(":")[0]] ?? 0) + 1;
  return {
    with_telem: { signals: withT.signals, companies: withT.companies, pass_gate: withT.pass_gate },
    without_telem: { signals: without.signals, companies: without.companies, pass_gate: without.pass_gate },
    gate_passers_that_need_telem: passWith.filter((c) => !passWithout.has(c.name.toLowerCase())).length,
    companies_only_telem_found: withT.cands.filter((c) => !knownWithout.has(c.name.toLowerCase())).length,
    telem_signals_by_source: bySource,
  };
}
const live = compare("signals");
const digest = read<Candidate[]>("candidates").filter((c) => c.status === "digest");
const sigs = new Map(read<Signal[]>("signals").map((s) => [s.id, s]));
const digestNeedsTelem = digest.filter((c) => { const fams = new Set(c.signal_ids.map((id) => sigs.get(id)!).filter((s) => s && !isTelem(s)).map((s) => s.source.split(":")[0])); return fams.size < 2; }).length;
const out = { generated_at: new Date().toISOString(), live: { ...live, digest: digest.length, digest_companies_that_would_fail_gate_without_telem: digestNeedsTelem }, backtest: compare("signals_backtest"), method: "Same stored signals, same entity resolution and gate; the without-Telem arm drops every signal that came from a Telem Monitor, a pinned Telem search or a routed Telem search. Tavily, SEC, GitHub and Hacker News stay in both arms." };
write("ablation", out);
console.log(JSON.stringify(out, null, 1));
