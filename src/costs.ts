// Spend report and per-run benchmark. `npx tsx src/costs.ts` prints it; `buildCosts()` feeds the UI.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "./env.ts";
import { read, write, type Run } from "./store.ts";
import { telem, logSpend } from "./telem.ts";
import { loadMonitors } from "./monitors.ts";

type Entry = { at: string; tool: string; op: string; usd: number; note: string };
const entries = (): Entry[] => {
  const f = join(DATA, "spend.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const r2 = (n: number) => +n.toFixed(2);

// Telem reports what each monitor job (compile, tick) cost. Record each finished job once, at the time it finished.
export async function syncMonitorCosts() {
  const seen = new Set(read<string[]>("monitor_jobs_logged", []));
  let added = 0;
  for (const [key, m] of Object.entries(loadMonitors())) {
    const jobs = (await telem("GET", `/v1/monitors/${m.id}/agent/jobs?limit=100`).catch(() => ({ jobs: [] }))).jobs ?? [];
    for (const j of jobs) {
      if (seen.has(j.id) || !j.finished_at) continue;
      seen.add(j.id);
      if (j.usd) { logSpend("telem_monitor", `${j.kind}:${key}`, j.usd, `job ${j.id} ${j.status}`); added += j.usd; }
    }
  }
  write("monitor_jobs_logged", [...seen]);
  return r2(added);
}

export function buildCosts() {
  const all = entries();
  const byTool: Record<string, { usd: number; calls: number }> = {};
  for (const e of all) { byTool[e.tool] ??= { usd: 0, calls: 0 }; byTool[e.tool].usd += e.usd; byTool[e.tool].calls++; }
  const runs = read<Run[]>("runs").filter((r) => r.status === "done");
  const per = (usd: number, n?: number) => (n ? +(usd / n).toFixed(3) : null);
  const bench = runs.map((r) => ({
    id: r.id, kind: r.kind, started_at: r.started_at, minutes: r.ended_at ? +((Date.parse(r.ended_at) - Date.parse(r.started_at)) / 60000).toFixed(1) : null,
    usd: r.usd, by_tool: r.by_tool, counts: r.counts,
    usd_per_signal: r.kind === "ingest" ? per(r.usd, r.counts.signals_added) : r.kind === "backtest" ? per(r.usd, r.counts.signals) : null,
    usd_per_digest_company: r.kind === "build" ? per(r.usd, r.counts.digest) : null,
    usd_per_scored_company: r.kind === "build" ? per(r.usd, r.counts.scored_now) : null,
  }));
  // The headline benchmark: the latest full search run is the latest ingest plus the build that followed it.
  const lastIngest = [...runs].reverse().find((r) => r.kind === "ingest");
  const lastBuild = [...runs].reverse().find((r) => r.kind === "build" && (!lastIngest || r.started_at >= lastIngest.started_at));
  const monitorUsd = all.filter((e) => e.tool === "telem_monitor").reduce((a, e) => a + e.usd, 0);
  const monitorTicks = all.filter((e) => e.tool === "telem_monitor" && e.op.startsWith("tick")).length;
  const cycle = lastIngest && lastBuild ? {
    usd: r2(lastIngest.usd + lastBuild.usd),
    signals_added: lastIngest.counts.signals_added, digest: lastBuild.counts.digest,
    usd_per_new_signal: per(lastIngest.usd + lastBuild.usd, lastIngest.counts.signals_added),
    usd_per_digest_company: per(lastIngest.usd + lastBuild.usd, lastBuild.counts.digest),
    note: "Pipeline calls only (searches, extraction, corroboration, gates, scoring). Monitor ticks are billed by Telem on their own schedule and shown separately.",
  } : null;
  return {
    total_usd: r2(all.reduce((a, e) => a + e.usd, 0)),
    by_tool: Object.fromEntries(Object.entries(byTool).map(([k, v]) => [k, { usd: r2(v.usd), calls: v.calls }])),
    last_search_cycle: cycle,
    monitors: { usd: r2(monitorUsd), ticks: monitorTicks, usd_per_tick: per(monitorUsd, monitorTicks) },
    runs: bench,
    basis: "Claude and Monid: metered per call. Telem monitor jobs: as reported by Telem. Telem searches ($0.005 per provider) and Tavily ($0.008 per credit): list-price estimates.",
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const added = await syncMonitorCosts();
  const c = buildCosts();
  console.log(`monitor job costs newly recorded: $${added}`);
  console.log(`TOTAL $${c.total_usd}`);
  for (const [k, v] of Object.entries(c.by_tool)) console.log(`  ${k.padEnd(14)} $${String(v.usd).padStart(6)}  ${v.calls} calls`);
  console.log(`monitors: $${c.monitors.usd} over ${c.monitors.ticks} ticks ($${c.monitors.usd_per_tick}/tick)`);
  console.log("last search cycle:", JSON.stringify(c.last_search_cycle));
  console.log("\nrun        kind      min    usd   $/signal  $/digest co  $/scored co  by tool");
  for (const r of c.runs) console.log(`${r.id.slice(0, 8)}  ${r.kind.padEnd(8)} ${String(r.minutes).padStart(5)} ${String(r.usd).padStart(6)}   ${String(r.usd_per_signal ?? "-").padStart(7)}  ${String(r.usd_per_digest_company ?? "-").padStart(10)}  ${String(r.usd_per_scored_company ?? "-").padStart(10)}  ${JSON.stringify(r.by_tool)}`);
}
