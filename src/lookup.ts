// Free primary-record lookup for companies the v2 gate drops or leaves one signal short.
// Sources: Hacker News (Algolia), GitHub, public job boards (Ashby, Greenhouse, Lever, YC jobs pages), SEC Form D full-text search.
// Match on the company's website first. A match on name alone is kept but flagged name_only.
// No model calls and no paid APIs. Results go to data/primary_lookup.json, never into signals.json; a company already looked up is skipped.
import "./env.ts";
import { read, write, hash, type Candidate, type Signal } from "./store.ts";
import { normName } from "./resolve.ts";
import { gateV2, hostOf } from "./tiers.ts";

type Found = Signal & { name_only: boolean; lookup: string };
const UA = { "User-Agent": "sourcing-engine-research/0.1" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const get = async (url: string, headers: Record<string, string> = {}, ms = 12000) => {
  try { return await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(ms), redirect: "follow" }); } catch { return null; }
};
const sameSite = (h: string, d: string) => h === d || h.endsWith("." + d);
const mk = (c: Candidate, lookup: string, source: string, signal_type: string, url: string, title: string, text: string, date: string | null, nameOnly: boolean, extra: Partial<Signal> = {}): Found => ({
  id: hash(`${lookup}|${url}`), source, signal_type, url, title, text, raw: text, date, label: "V", company: c.name, domain: nameOnly ? null : c.domains[0] ?? null,
  people: [], linkedin: null, github: null, sector: c.sector, is_startup: true, run: "lookup", ingested_at: new Date().toISOString(), name_only: nameOnly, lookup, ...extra,
} as Found);

async function hn(c: Candidate): Promise<Found[]> {
  const out: Found[] = [];
  for (const d of c.domains.slice(0, 2)) {
    const r = await get(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(d)}&restrictSearchableAttributes=url&tags=story&hitsPerPage=20`);
    if (!r?.ok) continue;
    for (const h of (await r.json()).hits ?? []) {
      if (!h.url || !sameSite(hostOf(h.url), d)) continue;
      out.push(mk(c, "hn_by_domain", "hn", "show_hn", `https://news.ycombinator.com/item?id=${h.objectID}`, h.title, `${h.title} | link=${h.url} | by=${h.author} | points=${h.points} | comments=${h.num_comments}`, h.created_at, false));
    }
  }
  return out.sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(0, 3);
}

const GH = (): Record<string, string> => (process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" } : { Accept: "application/vnd.github+json" });
async function github(c: Candidate): Promise<Found[]> {
  const handles = new Map<string, boolean>(); // handle -> matched on name only?
  for (const g of c.github) handles.set(g, false);
  const root = c.domains[0]?.split(".")[0];
  for (const q of [...new Set([root, normName(c.name)].filter(Boolean))] as string[]) {
    if (handles.size >= 3) break;
    const r = await get(`https://api.github.com/search/users?q=${encodeURIComponent(q)}+type:org&per_page=5`, GH());
    await sleep(2200); // search API allows 30 requests a minute
    if (!r?.ok) continue;
    for (const u of (await r.json()).items ?? []) {
      const o = await get(`https://api.github.com/orgs/${u.login}`, GH());
      if (!o?.ok) continue;
      const org = await o.json();
      const blog = hostOf(/^https?:/.test(org.blog ?? "") ? org.blog : `https://${org.blog ?? ""}`);
      if (blog && c.domains.some((d) => sameSite(blog, d))) handles.set(String(u.login).toLowerCase(), false);
    }
  }
  const out: Found[] = [];
  for (const [h, nameOnly] of handles) {
    const r = await get(`https://api.github.com/users/${h}/repos?sort=pushed&per_page=10`, GH());
    if (!r?.ok) continue;
    const repos = ((await r.json()) as any[]).filter((x) => !x.fork);
    if (!repos.length) continue;
    const top = repos.sort((a, b) => b.stargazers_count - a.stargazers_count)[0];
    const pushed = repos.map((x) => x.pushed_at).sort().pop();
    out.push(mk(c, "github_org", "github", "star_velocity", `https://github.com/${h}`, `GitHub: ${h}`, `${repos.length} public repositories, last push ${String(pushed).slice(0, 10)}; most starred ${top.full_name} (${top.stargazers_count} stars): ${top.description ?? ""}`, top.created_at, nameOnly, { github: h }));
  }
  return out;
}

async function jobs(c: Candidate): Promise<Found[]> {
  const slugs = [...new Set([c.domains[0]?.split(".")[0], normName(c.name), c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")].filter((s) => s && s.length >= 3))] as string[];
  const out: Found[] = [];
  const mentions = (body: string) => c.domains.some((d) => body.toLowerCase().includes(d));
  for (const s of slugs) {
    const boards: [string, string, string, (j: any) => any[]][] = [
      ["ashby", `https://api.ashbyhq.com/posting-api/job-board/${s}`, `https://jobs.ashbyhq.com/${s}`, (j) => j.jobs ?? []],
      ["greenhouse", `https://boards-api.greenhouse.io/v1/boards/${s}/jobs?content=true`, `https://boards.greenhouse.io/${s}`, (j) => j.jobs ?? []],
      ["lever", `https://api.lever.co/v0/postings/${s}?mode=json`, `https://jobs.lever.co/${s}`, (j) => (Array.isArray(j) ? j : [])],
    ];
    for (const [board, api, page, pick] of boards) {
      const r = await get(api);
      if (!r?.ok) continue;
      const body = await r.text();
      let list: any[] = [];
      try { list = pick(JSON.parse(body)); } catch { continue; }
      if (!list.length) continue;
      const titles = list.slice(0, 5).map((j) => j.title ?? j.text).filter(Boolean).join("; ");
      const dates = list.map((j) => j.publishedAt ?? j.updated_at ?? (j.createdAt ? new Date(j.createdAt).toISOString() : null)).filter(Boolean).sort();
      out.push(mk(c, `jobs_${board}`, "ats_lookup", "hiring", page, `${board} job board: ${s}`, `${list.length} open roles on ${board}: ${titles}`, dates[0] ?? null, !mentions(body)));
    }
    const y = await get(`https://www.ycombinator.com/companies/${s}`);
    if (y?.ok) {
      const html = await y.text();
      const n = new Set(html.match(new RegExp(`/companies/${s}/jobs/[A-Za-z0-9-]+`, "g")) ?? []).size;
      if (n && mentions(html)) out.push(mk(c, "jobs_yc", "ats_lookup", "hiring", `https://www.ycombinator.com/companies/${s}/jobs`, `YC jobs page: ${s}`, `${n} open roles listed on the company's YC jobs page`, null, false));
    }
  }
  const seen = new Set<string>();
  return out.filter((x) => (seen.has(x.url) ? false : (seen.add(x.url), true)));
}

async function formD(c: Candidate): Promise<Found[]> {
  const n = normName(c.name);
  if (!n || n.length < 5) return []; // too short to match on name safely
  const r = await get(`https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(`"${c.name.replace(/[,.]?\s+(inc|llc|corp|co|ltd)\.?$/i, "")}"`)}&forms=D&dateRange=custom&startdt=2024-01-01&enddt=${new Date().toISOString().slice(0, 10)}`);
  await sleep(200);
  if (!r?.ok) return [];
  const out: Found[] = [];
  for (const h of (await r.json()).hits?.hits ?? []) {
    const s = h._source;
    const name = String(s.display_names?.[0] ?? "").replace(/\s*\(CIK.*$/, "").trim();
    if (s.form !== "D" || normName(name) !== n) continue;
    const cik = String(s.ciks?.[0] ?? "").replace(/^0+/, "");
    out.push(mk(c, "form_d_by_name", "edgar_formd", "form_d", `https://www.sec.gov/Archives/edgar/data/${cik}/${String(s.adsh).replace(/-/g, "")}/primary_doc.xml`, `Form D: ${name}`, `${name} filed Form D on ${s.file_date}. Location: ${(s.biz_locations ?? []).join("; ")}. Incorporated: ${(s.inc_states ?? []).join(",")}.`, s.file_date, true));
  }
  return out.slice(0, 2);
}

if (process.argv[1]?.endsWith("lookup.ts")) {
  const cands = read<Candidate[]>("candidates");
  const sigById = new Map(read<Signal[]>("signals").map((s) => [s.id, s]));
  const store = read<Record<string, { at: string; found: Found[] }>>("primary_lookup", {});
  const targets = cands.filter((c) => {
    const g = gateV2(c.signal_ids.map((id) => sigById.get(id)).filter(Boolean) as Signal[], c);
    return !g.pass && (c.status === "digest" || g.primary.length === 1);
  });
  const todo = targets.filter((c) => !store[c.id]);
  console.log(`targets ${targets.length}, already looked up ${targets.length - todo.length}, to do ${todo.length}`);
  let i = 0;
  for (const c of todo) {
    const found = [...(await hn(c)), ...(await github(c)), ...(await jobs(c)), ...(await formD(c))];
    store[c.id] = { at: new Date().toISOString(), found };
    if (++i % 10 === 0) { write("primary_lookup", store); console.log(`  ${i}/${todo.length}`); }
  }
  write("primary_lookup", store);
  const all = targets.flatMap((c) => store[c.id]?.found ?? []);
  const by: Record<string, number> = {};
  for (const f of all) by[`${f.lookup}${f.name_only ? " (name only)" : ""}`] = (by[`${f.lookup}${f.name_only ? " (name only)" : ""}`] ?? 0) + 1;
  console.log(`records found: ${all.length} for ${targets.filter((c) => store[c.id]?.found.length).length} of ${targets.length} companies`, by);
}
