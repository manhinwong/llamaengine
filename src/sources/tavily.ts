import { need } from "../env.ts";
import { logSpend } from "../telem.ts";
import { read, write } from "../store.ts";
import type { RawItem } from "./edgar.ts";

const CREDIT_USD = 0.008; // pay-as-you-go list price per credit; event credits are free

export async function tavily(path: string, body: unknown): Promise<any> {
  const res = await fetch(`https://api.tavily.com/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${need("TAVILY_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`tavily ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export const MAP_TARGETS: { key: string; url: string; kind: "cohort" | "lab"; instructions?: string }[] = [
  { key: "yc_launches", url: "https://www.ycombinator.com/launches", kind: "cohort" },
  { key: "spc", url: "https://www.southparkcommons.com/companies", kind: "cohort" },
  { key: "hf0", url: "https://www.hf0.com", kind: "cohort" },
  { key: "pioneer", url: "https://pioneer.app", kind: "cohort" },
];

// Map a listing page, diff the URL set against the last snapshot in our store, return only new URLs.
export async function tavilyMapDiff(): Promise<RawItem[]> {
  const snaps = read<Record<string, string[]>>("tavily_snapshots", {});
  const out: RawItem[] = [];
  for (const t of MAP_TARGETS) {
    let r: any;
    try {
      r = await tavily("map", { url: t.url, max_depth: 2, limit: 150 });
    } catch (e: any) {
      console.log("tavily map failed", t.key, e.message);
      continue;
    }
    const urls: string[] = (r.results ?? []).map((u: any) => (typeof u === "string" ? u : u.url));
    logSpend("tavily", `map:${t.key}`, Math.ceil(Math.max(1, urls.length) / 10) * CREDIT_USD, `${urls.length} urls`);
    const prev = new Set(snaps[t.key] ?? []);
    const first = !snaps[t.key];
    const fresh = urls.filter((u) => !prev.has(u));
    snaps[t.key] = [...new Set([...(snaps[t.key] ?? []), ...urls])];
    console.log(`tavily map ${t.key}: ${urls.length} urls, ${fresh.length} new${first ? " (first snapshot)" : ""}`);
    for (const u of fresh) {
      out.push({
        source: "tavily_map",
        signal_type: t.kind === "cohort" ? "cohort" : "lab_roster_change",
        url: u,
        title: `${first ? "Listed on" : "New on"} ${t.key}: ${u}`,
        text: `URL ${u} ${first ? "present in first snapshot of" : "newly appeared on"} ${t.url} (${t.kind} page).`,
        date: first ? null : new Date().toISOString(),
        label: "V",
      });
    }
  }
  write("tavily_snapshots", snaps);
  return out;
}
