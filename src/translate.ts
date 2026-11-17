// Simplified-Chinese copies of the score detail text, for display only.
// Stored in data/zh.json keyed by a hash of the English text, so a re-run translates only text that is new or changed.
// Nothing in scoring or ranking reads this file; export.ts attaches the copies to the page data.
import { z } from "zod";
import "./env.ts";
import { read, write, zhKey, type Candidate, type Score } from "./store.ts";
import { structured, pool, EXTRACT_MODEL, claudeSpend } from "./claude.ts";

export function gradingTexts(): string[] {
  const cands = read<Candidate[]>("candidates").filter((c) => c.status === "digest" || c.status === "already_raised");
  const ids = new Set(cands.map((c) => c.id));
  const out = new Set<string>();
  for (const table of ["scores"]) for (const s of read<Score[]>(table)) {
    if (!ids.has(s.candidate_id)) continue;
    for (const d of Object.values(s.dims)) {
      if (d.level !== "U" && d.rationale) out.add(d.rationale);
      for (const cl of d.claims) if (cl.text) out.add(cl.text);
    }
  }
  for (const c of cands) if ((c as any).raised?.round) out.add((c as any).raised.round);
  return [...out];
}

const SYSTEM = `You translate short English notes about startups into Simplified Chinese (简体中文) for an investor-facing page.
Rules:
- Translate every item faithfully. Do not add, drop, soften or summarise anything.
- Keep company names, product names, person names, URLs, code identifiers, numbers, currency amounts and dates exactly as written.
- Keep the single-letter labels F, V, A and U as they are.
- Use natural, plain investor Chinese. No pinyin, no English in brackets after a translated term.
- Return one result per input item, with the same i.`;
const Out = z.object({ items: z.array(z.object({ i: z.number(), zh: z.string() })) });

if (process.argv[1]?.endsWith("translate.ts")) {
  const cache = read<Record<string, string>>("zh", {});
  const all = gradingTexts();
  const todo = all.filter((t) => !cache[zhKey(t)]);
  console.log(`grading texts: ${all.length}, already translated: ${all.length - todo.length}, to translate: ${todo.length}`);
  const batches: string[][] = [];
  for (let i = 0; i < todo.length; i += 20) batches.push(todo.slice(i, i + 20));
  let done = 0;
  await pool(batches, 4, async (b, n) => {
    const r = await structured({ schema: Out, system: SYSTEM, user: JSON.stringify(b.map((en, i) => ({ i, en }))), effort: "low", op: "translate_zh", model: EXTRACT_MODEL, maxTokens: 8000 });
    for (const it of r?.items ?? []) if (b[it.i] && it.zh.trim()) { cache[zhKey(b[it.i])] = it.zh.trim(); done++; }
    if (n % 5 === 0) write("zh", cache);
  });
  write("zh", cache);
  const left = all.filter((t) => !cache[zhKey(t)]).length;
  console.log(`translated ${done}, still missing ${left} (rerun to fill), claude this run $${claudeSpend().run}, total $${claudeSpend().total}`);
}
