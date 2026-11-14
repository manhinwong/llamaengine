import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA, need } from "./env.ts";

const BASE = () => process.env.TELEM_BASE_URL || "https://router.telem.ai";

export const logSpend = (tool: string, op: string, usd: number, note = "") => {
  mkdirSync(DATA, { recursive: true });
  appendFileSync(join(DATA, "spend.jsonl"), JSON.stringify({ at: new Date().toISOString(), tool, op, usd, note }) + "\n");
};

export async function telem<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE() + path, {
      method,
      headers: { Authorization: `Bearer ${need("TELEM_API_KEY")}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * Number(res.headers.get("retry-after") ?? 2)));
      continue;
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const e = new Error(`telem ${method} ${path} ${res.status} ${json?.error?.code ?? ""}: ${json?.error?.message ?? text.slice(0, 200)}`);
      (e as any).status = res.status;
      (e as any).code = json?.error?.code;
      throw e;
    }
    return json as T;
  }
}
