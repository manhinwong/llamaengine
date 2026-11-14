import type { Signal, Candidate } from "./store.ts";
import { hash } from "./store.ts";

const GENERIC = /(^|\.)(github\.com|github\.io|gitlab\.com|twitter\.com|x\.com|linkedin\.com|youtube\.com|youtu\.be|medium\.com|substack\.com|arxiv\.org|huggingface\.co|ycombinator\.com|sec\.gov|google\.com|apple\.com|notion\.site|notion\.so|vercel\.app|netlify\.app|producthunt\.com|ashbyhq\.com|lever\.co|greenhouse\.io|workatastartup\.com|pypi\.org|npmjs\.com|readthedocs\.io|discord\.gg|discord\.com|t\.me|reddit\.com)$/i;
export const cleanDomain = (d?: string | null) => {
  if (!d) return null;
  const h = d.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  return !h.includes(".") || GENERIC.test(h) ? null : h;
};
export const normName = (n?: string | null) => {
  if (!n) return null;
  const s = n.toLowerCase().replace(/[,.]?\s+(inc|llc|corp|corporation|co|ltd|limited|pbc|gmbh|holdings)\.?$/g, "").replace(/[^a-z0-9]+/g, "");
  return s.length >= 3 ? s : null;
};
const ghHandle = (g?: string | null) => (g ? g.toLowerCase().replace(/^https?:\/\/github\.com\//, "").split("/")[0] || null : null);
const liKey = (l?: string | null) => (l ? l.toLowerCase().replace(/^https?:\/\/(www\.)?linkedin\.com\//, "").replace(/\/$/, "") || null : null);

// Signal families: two signals from the same family are not independent.
export const family = (s: Signal) => s.source.split(":")[0].replace(/^telem_monitor$/, `telem_monitor/${s.signal_type}`);
const STRONG_TYPES = new Set(["left_job", "title_change", "linkedin_post", "launch_post", "form_d"]);

export function resolve(signals: Signal[], seedNames: string[]): Candidate[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => {
    for (const k of [a, b]) if (!parent.has(k)) parent.set(k, k);
    parent.set(find(a), find(b));
  };
  const keysOf = (s: Signal) => [cleanDomain(s.domain) && `d:${cleanDomain(s.domain)}`, liKey(s.linkedin) && `l:${liKey(s.linkedin)}`, ghHandle(s.github) && `g:${ghHandle(s.github)}`, normName(s.company) && `n:${normName(s.company)}`].filter(Boolean) as string[];

  const usable = signals.filter((s) => s.is_startup !== false && keysOf(s).length);
  // Pass 1: hard identifiers (domain, LinkedIn URL, GitHub handle).
  for (const s of usable) {
    const ks = keysOf(s).filter((k) => !k.startsWith("n:"));
    for (const k of ks) union(ks[0], k);
  }
  // Pass 2: names. Groups sharing a name merge only if together they point at no more than one website.
  const hardRoot = (s: Signal) => { const k = keysOf(s).find((k) => !k.startsWith("n:")); return k ? find(k) : null; };
  const byName = new Map<string, Signal[]>();
  for (const s of usable) { const n = normName(s.company); if (n) byName.set(n, [...(byName.get(n) ?? []), s]); }
  for (const [n, sigs] of byName) {
    const roots = new Set(sigs.map(hardRoot).filter(Boolean) as string[]);
    const domains = new Set<string>();
    for (const s of usable) { const r = hardRoot(s); if (r && roots.has(r) && cleanDomain(s.domain)) domains.add(cleanDomain(s.domain)!); }
    if (domains.size <= 1) for (const s of sigs) for (const k of keysOf(s)) union(`n:${n}`, k);
    else for (const s of sigs) { const r = hardRoot(s); if (!r) union(`n:${n}`, `n:${n}`); } // name-only signals stay their own group
  }
  const rootKey = (s: Signal) => { const ks = keysOf(s); const hard = ks.find((k) => !k.startsWith("n:")); return hard ?? ks[0]; };
  const groups = new Map<string, Signal[]>();
  for (const s of usable) {
    const root = find(rootKey(s));
    groups.set(root, [...(groups.get(root) ?? []), s]);
  }
  const seeds = new Set(seedNames.map((n) => n.toLowerCase()));
  const out: Candidate[] = [];
  for (const [root, sigs] of groups) {
    const uniq = <T>(a: (T | null | undefined)[]) => [...new Set(a.filter(Boolean) as T[])];
    const people = uniq(sigs.flatMap((s) => s.people ?? []));
    const seed_hit = people.some((p) => seeds.has(p.toLowerCase())) || sigs.some((s) => s.seed_person);
    const fams = uniq(sigs.map(family));
    const strongOnSeed = seed_hit && sigs.some((s) => s.strong || STRONG_TYPES.has(s.signal_type));
    const pass = fams.length >= 2 || strongOnSeed;
    const dates = sigs.map((s) => s.date).filter(Boolean).sort() as string[];
    const sectors = sigs.map((s) => s.sector).filter((x) => x && x !== "other") as string[];
    const sector = sectors.sort((a, b) => sectors.filter((x) => x === b).length - sectors.filter((x) => x === a).length)[0] ?? "other";
    const names = uniq(sigs.map((s) => s.company));
    out.push({
      id: hash(root),
      name: names.sort((a, b) => a.length - b.length)[0] ?? root.slice(2),
      domains: uniq(sigs.map((s) => cleanDomain(s.domain))),
      linkedin: uniq(sigs.map((s) => s.linkedin)),
      github: uniq(sigs.map((s) => ghHandle(s.github))),
      people,
      signal_ids: sigs.map((s) => s.id),
      signal_types: uniq(sigs.map((s) => s.signal_type)),
      sources: fams,
      first_seen: dates[0] ?? null,
      sector,
      tags: uniq(sigs.flatMap((s) => s.tags ?? [])),
      seed_hit,
      gate: { pass, reason: pass ? (fams.length >= 2 ? `${fams.length} independent signal families: ${fams.join(", ")}` : "strong signal on a seed person") : `only 1 signal family (${fams.join(", ")})` },
      status: pass ? "digest" : "gated_out",
    });
  }
  return out;
}
