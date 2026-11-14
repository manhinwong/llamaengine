// Public half of the seed list: current PhD students and recent alumni from top robotics/ML lab "people" pages.
import "./env.ts";
import { z } from "zod";
import { tavily } from "./sources/tavily.ts";
import { structured, EXTRACT_MODEL } from "./claude.ts";
import { logSpend } from "./telem.ts";
import { write, startRun, endRun } from "./store.ts";

const LABS = [
  { lab: "Berkeley RAIL", url: "https://rail.eecs.berkeley.edu/people.html" },
  { lab: "Stanford IRIS", url: "https://irislab.stanford.edu/people.html" },
  { lab: "MIT LIS", url: "https://lis.csail.mit.edu/people/" },
  { lab: "Princeton IRoM", url: "https://irom-lab.princeton.edu/people/" },
  { lab: "CMU R-PAD", url: "https://r-pad.github.io/people" },
];
const Out = z.object({ people: z.array(z.object({ name: z.string(), role: z.enum(["phd_student", "postdoc", "recent_alumni"]), homepage: z.string().nullable() })) });

const run = startRun("seeds");
const r = await tavily("extract", { urls: LABS.map((l) => l.url) });
logSpend("tavily", "extract:labs", 0.008, `${LABS.length} urls`);
const seeds: { name: string; role: string; lab: string; source_url: string; homepage: string | null }[] = [];
for (const l of LABS) {
  const page = (r.results ?? []).find((x: any) => String(x.url).startsWith(l.url.replace(/\/$/, "")));
  if (!page?.raw_content) { console.log(`no content: ${l.lab}`); continue; }
  const out = await structured({
    schema: Out, effort: "low", op: "seeds", model: EXTRACT_MODEL, maxTokens: 2000,
    system: "From a university lab's people page, list current PhD students, postdocs and alumni who left within about the last two years. Use only names written on the page. Skip faculty, staff, undergraduates and visitors. At most 8 people, preferring PhD students.",
    user: `Lab: ${l.lab}\n\n${String(page.raw_content).slice(0, 20000)}`,
  });
  for (const p of out?.people ?? []) seeds.push({ ...p, lab: l.lab, source_url: l.url });
  console.log(`${l.lab}: ${out?.people.length ?? 0}`);
}
write("seeds", seeds);
endRun(run, { seeds: seeds.length });
console.log(`seeds: ${seeds.length}`);
