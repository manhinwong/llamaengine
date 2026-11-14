import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./env.ts";
import { z } from "zod";
import { structured, pool } from "./claude.ts";
import type { Candidate, Signal, Score, DimScore } from "./store.ts";

const RUBRIC_PATH = join(ROOT, "rubric.json");
type Dim = { key: string; label: string; weight: number; body_en: string };
export const rubric = (): { version: string; dimensions: Dim[] } => JSON.parse(readFileSync(process.env.RUBRIC_PATH ?? RUBRIC_PATH, "utf8"));

// Interval rule: P = points on assessed dimensions, C = assessed weight. Interval [P + (100-C)/5, P + (100-C)]. Never normalize.
export function interval(dims: Record<string, DimScore>, R = rubric()) {
  let P = 0, C = 0;
  for (const d of R.dimensions) {
    const lv = dims[d.key]?.level;
    if (typeof lv === "number") { P += (d.weight * lv) / 5; C += d.weight; }
  }
  return { P: +P.toFixed(1), C, lower: +(P + (100 - C) / 5).toFixed(1), upper: +(P + (100 - C)).toFixed(1) };
}

const NEVER_PRECONTACT = new Set(["investor_hype", "growth_path"]);
const Claim = z.object({ text: z.string(), label: z.enum(["F", "V", "A"]), url: z.string() });
const DimOut = z.object({ key: z.string(), level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal("U")]), rationale: z.string(), claims: z.array(Claim) });
const Out = z.object({ dims: z.array(DimOut) });

const system = (R: ReturnType<typeof rubric>) => `You score an early-stage company BEFORE any contact with the founders, using only the evidence items given.
Rubric v${R.version} dimensions and level definitions:

${R.dimensions.map((d) => `## ${d.key} (${d.label})\n${d.body_en}`).join("\n\n")}

Rules:
- Return every dimension key exactly once.
- Level "U" (unknown) is the default. Give a numeric level only when the evidence items contain primary evidence for that dimension. An empty field is better than a plausible guess.
- investor_hype and growth_path are always "U" before contact. Do not proxy hype with investor names, accelerator membership or star counts.
- product_value is "U" unless the product is public and testable and the evidence shows real use.
- Every claim cites the url of one evidence item, copied exactly, and carries a label: F = founder's own claim (their site, post, launch text), V = verified primary record (SEC filing, GitHub API count, dated registry), A = your inference.
- A dimension scored only from A claims must be "U".
- Do not use knowledge from outside the evidence items.`;

export async function scoreCandidates(cands: Candidate[], signals: Signal[], extraEvidence: Record<string, { url: string; text: string }[]> = {}): Promise<Score[]> {
  const R = rubric();
  const byId = new Map(signals.map((s) => [s.id, s]));
  const res = await pool(cands, 5, async (c) => {
    const ev = [
      ...c.signal_ids.map((id) => byId.get(id)!).filter(Boolean).map((s) => ({ url: s.url, label: s.label, text: `[${s.source}/${s.signal_type}, ${s.date ?? "undated"}] ${s.title}. ${s.raw ?? ""}` })),
      ...(extraEvidence[c.id] ?? []).map((e) => ({ url: e.url, label: "F", text: `[company site] ${e.text.slice(0, 2500)}` })),
    ];
    const user = `Company: ${c.name}\nSector tag: ${c.sector}\nPeople named in evidence: ${c.people.join(", ") || "none"}\n\nEvidence items:\n${ev.map((e, i) => `(${i + 1}) url=${e.url}\nsource label=${e.label}\n${e.text}`).join("\n\n")}`;
    const out = await structured({ schema: Out, system: system(R), user, effort: "high", op: "score", maxTokens: 6000 });
    if (!out) return null;
    const urls = new Set(ev.map((e) => e.url));
    const dims: Record<string, DimScore> = {};
    for (const d of R.dimensions) {
      const o = out.dims.find((x) => x.key === d.key);
      const claims = (o?.claims ?? []).filter((cl) => urls.has(cl.url));
      const grounded = claims.some((cl) => cl.label !== "A");
      const level = !o || o.level === "U" || NEVER_PRECONTACT.has(d.key) || !grounded ? "U" : o.level;
      dims[d.key] = { level, rationale: o?.rationale ?? "", claims };
    }
    return { candidate_id: c.id, dims, ...interval(dims, R), scored_at: new Date().toISOString() } as Score;
  });
  return res.filter(Boolean) as Score[];
}
