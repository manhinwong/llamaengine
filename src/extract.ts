import { z } from "zod";
import { structured, pool, EXTRACT_MODEL, BudgetError } from "./claude.ts";
import type { RawItem } from "./sources/edgar.ts";
import type { Signal } from "./store.ts";

const Item = z.object({
  i: z.number().describe("index of the input item"),
  is_startup: z.boolean().describe("true only if this item is evidence of a specific early-stage (pre-seed/seed or not-yet-funded) company or founding team. false for big companies, hobby projects with no company intent, funds, SPVs, real-estate vehicles, news roundups."),
  company: z.string().nullable().describe("company or project name exactly as written; null if none"),
  domain: z.string().nullable().describe("the company's own website hostname if stated in the item (not github.com, linkedin.com, ycombinator.com, sec.gov); null if not stated"),
  people: z.array(z.string()).describe("full names of founders/authors stated in the item; empty if none"),
  linkedin: z.string().nullable(),
  github: z.string().nullable().describe("GitHub org or user handle if stated"),
  sector: z.enum(["robotics", "hardware", "software_for_hardware", "security", "ai_infra", "ai_app", "dev_tools", "other"]).describe("security = security, verification, testing or trust tooling for AI agents or for AI-written code; it takes priority over ai_infra and dev_tools when it applies"),
  tags: z.array(z.enum(["proves_by_running", "agent_runtime_controls", "code_verification", "open_source", "works_across_agents"])).describe("Only tags the item itself states. proves_by_running = findings are shown by executing something (a test, exploit or reproduction), not by a model's opinion. agent_runtime_controls = policy, gateway, sandbox, permission or approval controls on what an AI agent may do. code_verification = checks or tests code written by AI. open_source = the product is open source. works_across_agents = works with several coding agents, models or repos rather than one. Empty when none is stated."),
  same_as_target: z.boolean().nullable().describe("Only when the item text names a target company with context: true if this item is about that same company (same product, people or website), false if it is a different company that shares the name or the match is unclear. null when no target is given."),
  summary: z.string().describe("one sentence: what this item shows, in plain words"),
});
const Out = z.object({ items: z.array(Item) });

const SYSTEM = `You extract early-stage startup signals from raw web items for a venture sourcing engine.
Only report what the item itself states. Never guess a domain, a person or a LinkedIn URL: use null or an empty list when the item does not state it.
SEC Form D filers that are investment funds, SPVs, LPs, trusts or real-estate vehicles are not startups.
A GitHub repo counts only when it looks like the start of a product or company (an org, a homepage, a named team), not a tutorial, list or personal toy.`;

export async function extract(raw: RawItem[], runKind: "live" | "backtest" = "live"): Promise<Omit<Signal, "id" | "ingested_at">[]> {
  const batches: RawItem[][] = [];
  for (let i = 0; i < raw.length; i += 12) batches.push(raw.slice(i, i + 12));
  // A reply that comes back cut off or malformed loses the whole batch, so a failed batch is split in half and retried.
  const run = async (batch: RawItem[], depth = 0): Promise<Omit<Signal, "id" | "ingested_at">[]> => {
    const user = batch.map((r, i) => `[${i}] source=${r.source} type=${r.signal_type} date=${r.date ?? "unknown"}\nurl=${r.url}\ntitle=${r.title}\ntext=${r.text.slice(0, 2200)}`).join("\n\n");
    let out: z.infer<typeof Out> | null = null;
    try { out = await structured({ schema: Out, system: SYSTEM, user, effort: "low", op: "extract", model: EXTRACT_MODEL, maxTokens: 12000 }); }
    catch (e: any) { if (e instanceof BudgetError) throw e; }
    if (!out) {
      if (batch.length === 1 || depth >= 3) { lost += batch.length; return []; }
      const mid = Math.ceil(batch.length / 2);
      return [...(await run(batch.slice(0, mid), depth + 1)), ...(await run(batch.slice(mid), depth + 1))];
    }
    return out.items.filter((x) => batch[x.i] && !(batch[x.i].source === "telem_search" && x.same_as_target !== true)).map((x) => {
      const r = batch[x.i];
      return {
        source: r.source, signal_type: r.signal_type, url: r.url, title: r.title, text: x.summary, raw: r.text.slice(0, 3000), date: r.date, label: r.label,
        company: r.source === "telem_search" ? ((r.hint?.company as string) ?? x.company) : x.company, domain: x.domain?.toLowerCase().replace(/^www\./, "") ?? null, people: x.people, linkedin: x.linkedin, github: x.github ?? (r.hint?.github as string) ?? null,
        sector: x.sector, tags: x.tags ?? [], is_startup: x.is_startup, run: runKind,
      };
    });
  };
  let lost = 0;
  const res = await pool(batches, 6, (batch) => run(batch));
  if (lost) console.log(`  extraction: ${lost} items lost after retries`);
  return res.flat().filter(Boolean);
}
