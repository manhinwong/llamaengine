import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "./env.ts";
import { telem } from "./telem.ts";

type Spec = { key: string; query: string; include_domains?: string[]; num_results?: number };

export const MONITOR_SPECS: Spec[] = [
  { key: "stealth_launch", query: "A new robotics or AI startup announces it is coming out of stealth, launching, or raising a pre-seed round", num_results: 20 },
  {
    key: "founding_engineer",
    query: "A newly founded AI or robotics startup posts a founding engineer or first engineering hire job",
    include_domains: ["jobs.ashbyhq.com", "jobs.lever.co", "boards.greenhouse.io", "workatastartup.com"],
    num_results: 20,
  },
  { key: "show_hn", query: "A Show HN or Launch HN post introducing a new AI, robotics or developer-infrastructure product built by a small founding team", include_domains: ["news.ycombinator.com"], num_results: 20 },
  { key: "arxiv_spinout", query: "A new arXiv cs.RO or cs.LG paper whose authors say they are starting a company or have released an open-source project around it", include_domains: ["arxiv.org", "github.com"], num_results: 20 },
  { key: "left_to_start", query: "A researcher or engineer announces leaving OpenAI, Anthropic, Google DeepMind, Tesla, Figure or a top university lab to start a new company", num_results: 20 },
  { key: "hardware_stealth", query: "A stealth robotics or hardware startup is hiring mechanical, electrical or firmware engineers as its first hires", num_results: 20 },
  { key: "accelerator_cohort", query: "A new company is announced as part of an HF0, South Park Commons, Pioneer, Kleiner Perkins Fellows or Y Combinator batch", num_results: 20 },
];

const FILE = join(DATA, "monitors.json");
type Saved = Record<string, { id: string; query: string; created_at: string }>;
export const loadMonitors = (): Saved => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {});
const save = (s: Saved) => (mkdirSync(DATA, { recursive: true }), writeFileSync(FILE, JSON.stringify(s, null, 2)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function create(extra: Spec[] = []) {
  const saved = loadMonitors();
  const existing = await telem("GET", "/v1/monitors?limit=50");
  const live: any[] = existing.monitors ?? existing.data ?? existing.items ?? [];
  for (const spec of [...MONITOR_SPECS, ...extra]) {
    const match = live.find((m) => m.query === spec.query && m.status !== "ended");
    if (match) {
      saved[spec.key] = { id: match.id, query: spec.query, created_at: match.created_at };
      console.log("exists", spec.key, match.id);
      continue;
    }
    const m = await telem("POST", "/v1/monitors", {
      query: spec.query,
      agent: true,
      ttl: "2d",
      options: {
        frequency: "6h", // hourly ticks cost up to $5 each on the first run; slowed on 2026-11-14 to protect credit
        ...(spec.include_domains ? { include_domains: spec.include_domains } : {}),
        search: { num_results: spec.num_results ?? 10 },
      },
    });
    saved[spec.key] = { id: m.id, query: spec.query, created_at: m.created_at ?? new Date().toISOString() };
    save(saved);
    console.log("created", spec.key, m.id, JSON.stringify(m.agent_state ?? {}));
  }
  save(saved);
}

export async function tickAll() {
  const saved = loadMonitors();
  for (const [key, m] of Object.entries(saved)) {
    for (let i = 0; i < 20; i++) {
      const mon = await telem("GET", `/v1/monitors/${m.id}`);
      const st = mon.agent_state?.status;
      if (st && st !== "compiling") break;
      await sleep(3000);
    }
    try {
      const t = await telem("POST", `/v1/monitors/${m.id}/agent/ticks`);
      console.log("tick", key, t.job_id);
    } catch (e: any) {
      console.log("tick", key, "->", e.code ?? e.message);
    }
  }
}

async function status() {
  for (const [key, m] of Object.entries(loadMonitors())) {
    const mon = await telem("GET", `/v1/monitors/${m.id}`);
    console.log(key, m.id, mon.status, JSON.stringify(mon.agent_state));
  }
}

const cmd = process.argv[2];
if (import.meta.url === `file://${process.argv[1]}`) {
  if (cmd === "create") await create();
  else if (cmd === "tick") await tickAll();
  else if (cmd === "status") await status();
  else if (cmd === "up") (await create(), await tickAll());
  else if (cmd === "seed") {
    // Eighth monitor: arXiv papers by the public seed people. Created once the seed list exists.
    const names = (JSON.parse(readFileSync(join(DATA, "seeds.json"), "utf8")) as { name: string }[]).map((s) => s.name).slice(0, 24);
    await create([{ key: "arxiv_seed", query: `A new arXiv cs.RO or cs.LG paper, project page or company announcement by any of these researchers: ${names.join(", ")}`, include_domains: ["arxiv.org", "github.io", "github.com"], num_results: 20 }]);
  }
  else console.log("usage: monitors create|tick|status|up");
}
