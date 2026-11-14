import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { need, DATA } from "./env.ts";
import { logSpend } from "./telem.ts";

// baseURL is explicit: the shell may export ANTHROPIC_BASE_URL for another tool. maxRetries is low so a failing call cannot multiply cost.
// Created on first use, so the web page and the reports run without a model key.
let _client: Anthropic | null = null;
const client = () => (_client ??= new Anthropic({ apiKey: need("ANTHROPIC_API_KEY"), baseURL: "https://api.anthropic.com", maxRetries: 1 }));

// Scoring is the judgement step and stays on Opus. Extraction is bulk field-pulling and runs on Haiku (about 40x cheaper).
export const SCORE_MODEL = process.env.SCORE_MODEL ?? "claude-opus-5-5";
export const EXTRACT_MODEL = process.env.EXTRACT_MODEL ?? "claude-haiku-5-5";
const PRICE: Record<string, [number, number]> = { "claude-opus-5-5": [4, 20], "claude-haiku-5-5": [0.1, 0.5], "claude-sonnet-5-5": [2, 10] }; // $ per million tokens, input / output

// Hard caps. Every call checks both before it is sent; over the cap, the call is refused, not queued.
//   CLAUDE_BUDGET_USD      all-time spend recorded in data/spend.jsonl (default $35)
//   CLAUDE_RUN_BUDGET_USD  spend by this one process (default $4)
const TOTAL_CAP = Number(process.env.CLAUDE_BUDGET_USD ?? 35);
const RUN_CAP = Number(process.env.CLAUDE_RUN_BUDGET_USD ?? 4);
const spentBefore = (() => {
  const f = join(DATA, "spend.jsonl");
  if (!existsSync(f)) return 0;
  return readFileSync(f, "utf8").split("\n").filter(Boolean).reduce((a, l) => { const e = JSON.parse(l); return e.tool === "claude" ? a + e.usd : a; }, 0);
})();
let spentRun = 0, reserved = 0, warned = false;
export class BudgetError extends Error {}
export const claudeSpend = () => ({ total: +(spentBefore + spentRun).toFixed(2), run: +spentRun.toFixed(2), total_cap: TOTAL_CAP, run_cap: RUN_CAP });

export async function structured<S extends z.ZodTypeAny>(opts: { schema: S; system: string; user: string; effort: "low" | "medium" | "high"; op: string; model?: string; maxTokens?: number }): Promise<z.infer<S> | null> {
  const model = opts.model ?? SCORE_MODEL;
  const [pin, pout] = PRICE[model] ?? PRICE["claude-opus-5-5"];
  const maxTokens = opts.maxTokens ?? 8000;
  // Reserve the worst case for this call (input estimated at 3.2 chars per token, output at a third of max_tokens) so parallel calls cannot overshoot together.
  const worst = (((opts.system.length + opts.user.length) / 3.2) * pin + (maxTokens / 3) * pout) / 1e6;
  if (spentBefore + spentRun + reserved + worst > TOTAL_CAP || spentRun + reserved + worst > RUN_CAP) {
    if (!warned) { warned = true; console.log(`CLAUDE BUDGET REACHED: total $${(spentBefore + spentRun).toFixed(2)} of $${TOTAL_CAP}, this run $${spentRun.toFixed(2)} of $${RUN_CAP}. Further Claude calls in this run are refused. Raise CLAUDE_BUDGET_USD or CLAUDE_RUN_BUDGET_USD in .env to continue.`); }
    throw new BudgetError("claude budget reached");
  }
  reserved += worst;
  try {
    const stream = client().messages.stream({
      model,
      max_tokens: maxTokens,
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
      output_config: { effort: opts.effort, format: zodOutputFormat(opts.schema) },
    });
    const msg = await stream.finalMessage();
    const u = msg.usage;
    const usd = (u.input_tokens * pin + u.output_tokens * pout) / 1e6;
    spentRun += usd;
    logSpend("claude", opts.op, usd, `${model} ${u.input_tokens}in/${u.output_tokens}out`);
    if (msg.stop_reason === "refusal" || msg.stop_reason === "max_tokens") {
      console.log(`claude ${opts.op}: stop_reason=${msg.stop_reason}`);
      return null;
    }
    const text = msg.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") return null;
    try {
      return opts.schema.parse(JSON.parse(text.text));
    } catch (e: any) {
      console.log(`claude ${opts.op}: parse failed ${e.message?.slice(0, 120)}`);
      return null;
    }
  } finally {
    reserved -= worst;
  }
}

export async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0, stop = false;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length && !stop) {
      const k = i++;
      try { out[k] = await fn(items[k], k); }
      catch (e: any) { if (e instanceof BudgetError) stop = true; else console.log("pool item failed:", e.message?.slice(0, 160)); }
    }
  }));
  return out;
}
