import { telem, logSpend } from "../telem.ts";
import { read, write } from "../store.ts";
import { loadMonitors } from "../monitors.ts";
import type { RawItem } from "./edgar.ts";

export type TelemResult = { url: string; title: string; summary?: string; excerpt?: string; publish_date?: string | null; provider: string };

// One Telem search. `providers` pins site providers (apify_linkedin, fetchlayer_x, fetchlayer_producthunt); omit it to let Telem route.
export async function telemSearch(query: string, opts: { providers?: string[]; num?: number; published_after?: string; published_before?: string; include_domains?: string[]; op: string }): Promise<TelemResult[]> {
  const search: any = { num_results: opts.num ?? 10, tier: "extended" };
  if (opts.providers) search.providers = { include: opts.providers };
  else search.auto_routing = "accuracy";
  for (const k of ["published_after", "published_before", "include_domains"] as const) if (opts[k]) search[k] = opts[k];
  const r = await telem("POST", "/v1/search", { user_input: { query }, search });
  const out: TelemResult[] = [];
  for (const run of r.preprocessor_runs ?? []) {
    if (run.status !== "succeeded") continue;
    for (const x of run.output_payload?.results ?? []) out.push({ ...x, provider: run.preprocessor_name });
  }
  logSpend("telem", opts.op, 0.005 * Math.max(1, (r.preprocessor_runs ?? []).length), `${query.slice(0, 60)} -> ${out.length}`);
  return out;
}

const KIND_TO_TYPE: Record<string, string> = { stealth_launch: "launch_post", founding_engineer: "hiring", show_hn: "show_hn", arxiv_spinout: "paper", left_to_start: "left_job", hardware_stealth: "hiring", accelerator_cohort: "cohort", arxiv_seed: "paper" };
const urlsIn = (o: unknown) => [...new Set(JSON.stringify(o).match(/https?:\/\/[^\s"\\<>)]+/g) ?? [])];

// Read each monitor's changes after the stored seq cursor. A seq is handled once: the cursor only moves forward.
export async function ingestMonitorChanges(): Promise<RawItem[]> {
  const cursors = read<Record<string, number>>("monitor_cursors", {});
  const out: RawItem[] = [];
  for (const [key, m] of Object.entries(loadMonitors())) {
    let cursor = cursors[m.id] ?? 0;
    const entities = new Map<string, { name: string; at: string; seq: number; url?: string; status?: string }>();
    for (;;) {
      const page = await telem("GET", `/v1/monitors/${m.id}/agent/changes?cursor=${cursor}&limit=200`);
      for (const ch of page.changes ?? []) {
        if (ch.seq <= cursor) continue;
        if ((ch.kind === "entity_added" || ch.kind === "fact_status_changed" || ch.kind === "value_changed") && ch.subject?.entity_id) entities.set(ch.subject.entity_id, { ...(entities.get(ch.subject.entity_id) ?? {}), name: ch.subject.name, at: ch.at, seq: ch.seq, ...(ch.after?.url ? { url: ch.after.url } : {}), ...(ch.after?.status ? { status: ch.after.status } : {}) });
      }
      const next = page.next_cursor ?? cursor;
      if (next <= cursor) break;
      cursor = next;
      if (cursor >= (page.watermark ?? cursor)) break;
    }
    // Object detail carries the pages the agent read; those URLs are the evidence.
    const objs = entities.size ? await telem("GET", `/v1/monitors/${m.id}/agent/objects?limit=200`).catch(() => ({ objects: [] })) : { objects: [] };
    for (const [eid, e] of entities) {
      const o = (objs.objects ?? []).find((x: any) => (e.url && (x.urls ?? []).includes(e.url)) || x.name === e.name);
      if ((o?.status ?? e.status) === "rejected") continue;
      const url = e.url ?? o?.urls?.[0] ?? urlsIn(o ?? {})[0];
      if (!url) continue;
      // Attribute values come with the quote and page URL the monitor agent read them from.
      const attrs = Object.entries(o?.attributes ?? {}).map(([k, v]: [string, any]) => `${k}: ${v?.display ?? v?.value}${v?.quote ? ` (page says: "${String(v.quote).slice(0, 260)}")` : ""}`).join("\n");
      out.push({
        source: `telem_monitor:${key}`,
        signal_type: KIND_TO_TYPE[key] ?? "launch_post",
        url,
        title: `${e.name} (Telem monitor "${key}", seq ${e.seq})`,
        text: `Found by a Telem Monitor watching: ${m.query}\nItem: ${e.name} (${o?.kind ?? "item"}, monitor verdict: ${o?.status ?? e.status ?? "unknown"})\n${attrs}`.slice(0, 2600),
        date: e.at,
        label: "F",
        hint: { company: o?.attributes?.company_name?.value ?? e.name },
      });
    }
    cursors[m.id] = cursor;
    console.log(`  monitor ${key}: cursor -> ${cursor}, entities ${entities.size}`);
  }
  write("monitor_cursors", cursors);
  return out;
}

// Monitors take no provider pin, so LinkedIn posts, X and Product Hunt run as our own scheduled pinned searches; the store diffs by URL.
const PINNED: { provider: string; source: string; type: string; queries: string[] }[] = [
  { provider: "apify_linkedin", source: "telem_linkedin", type: "linkedin_post", queries: ["starting a new robotics company stealth", "excited to announce I left to start a new AI company", "we are hiring our first founding engineer robotics", "building something new in stealth physical AI"] },
  { provider: "fetchlayer_x", source: "telem_x", type: "x_post", queries: ["launching our robotics startup today out of stealth", "I quit my job to start an AI company", "we just open sourced our robot foundation model"] },
  { provider: "fetchlayer_producthunt", source: "telem_producthunt", type: "producthunt", queries: ["AI agents developer tool launch", "robotics"] },
];

const SECURITY_PINNED: { provider: string; source: string; type: string; q: string }[] = [
  { provider: "apify_linkedin", source: "telem_linkedin", type: "linkedin_post", q: "launching startup security for AI agents" },
  { provider: "apify_linkedin", source: "telem_linkedin", type: "linkedin_post", q: "we are building verification for AI-generated code founding team" },
  { provider: "fetchlayer_x", source: "telem_x", type: "x_post", q: "open sourced our AI agent security tool MCP gateway sandbox" },
  { provider: "fetchlayer_x", source: "telem_x", type: "x_post", q: "launching today: we test and verify AI-written code" },
  { provider: "fetchlayer_producthunt", source: "telem_producthunt", type: "producthunt", q: "AI agent security" },
];
const SECURITY_ROUTED = [
  "new startup building runtime security controls for AI agents, launch or pre-seed",
  "startup that verifies AI-written code by running tests or exploits, launch announcement",
  "Show HN security tool for AI coding agents",
  "new open source MCP gateway or agent permission policy engine by a startup",
  "startup red teaming AI agents with adaptive attacks founded 2026",
  "founding engineer job AI agent security startup",
];

// Security and verification discovery: pinned social searches plus auto-routed web searches.
export async function securityDiscovery(): Promise<RawItem[]> {
  const out: RawItem[] = [];
  const after = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
  for (const p of SECURITY_PINNED) {
    try {
      for (const r of await telemSearch(p.q, { providers: [p.provider], num: 20, op: `pinned:${p.provider}` })) out.push({ source: p.source, signal_type: p.type, url: r.url, title: r.title, text: `${r.summary ?? ""} ${r.excerpt ?? ""}`.slice(0, 1200), date: r.publish_date ?? null, label: "F" });
    } catch (e: any) { console.log(`  security pinned ${p.provider} failed: ${e.message?.slice(0, 120)}`); }
  }
  for (const q of SECURITY_ROUTED) {
    try {
      const rs = await telemSearch(q, { num: 10, published_after: after, op: "discover:security" });
      for (const r of [...new Map(rs.map((r) => [r.url, r])).values()]) out.push({ source: "telem_discover", signal_type: "launch_post", url: r.url, title: r.title, text: `${r.summary ?? ""} ${r.excerpt ?? ""}`.slice(0, 1200), date: r.publish_date ?? null, label: "F" });
    } catch (e: any) { console.log(`  security routed search failed: ${e.message?.slice(0, 120)}`); }
  }
  return out;
}

export async function pinnedSearches(seedNames: string[]): Promise<RawItem[]> {
  const out: RawItem[] = [];
  const jobs = PINNED.flatMap((p) => p.queries.map((q) => ({ p, q, seed: false })));
  // LinkedIn post search over the seed list, 20 posts max per call.
  for (const name of seedNames.slice(0, 30)) jobs.push({ p: PINNED[0], q: `"${name}" starting new company OR founder OR stealth`, seed: true });
  for (const { p, q, seed } of jobs) {
    try {
      const rs = await telemSearch(q, { providers: [p.provider], num: 20, op: `pinned:${p.provider}` });
      for (const r of rs) out.push({ source: p.source, signal_type: p.type, url: r.url, title: r.title, text: `${r.summary ?? ""} ${r.excerpt ?? ""}`.slice(0, 1200), date: r.publish_date ?? null, label: "F", hint: { seed_query: seed ? q : undefined } });
    } catch (e: any) { console.log(`  pinned ${p.provider} failed: ${e.message?.slice(0, 120)}`); }
  }
  return out;
}
