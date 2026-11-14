import { execFileSync } from "node:child_process";
import { logSpend } from "./telem.ts";

export function monid(provider: string, endpoint: string, body: unknown, op: string, perResultUsd = 0.06): any {
  const raw = execFileSync("monid", ["run", "-p", provider, "-e", endpoint, "-i", JSON.stringify(body), "-w", "120", "-j"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const j = JSON.parse(raw);
  logSpend("monid", op, (j.billedUnits ?? j.resultCount ?? 0) * perResultUsd, `${provider}${endpoint} rows=${j.resultCount ?? 0}`);
  if (j.status === "BLOCKED") throw new Error(`monid blocked: ${String(j.reason).slice(0, 160)}`);
  if (!j.output?.success) throw new Error(`monid ${provider}${endpoint}: ${JSON.stringify(j.providerResponse ?? j.output).slice(0, 200)}`);
  return j.output.data;
}

export type FundableCo = { name: string; domain: string | null; total_raised: number | null; latest_deal: { type: string; date: string; total_round_raised: number | null; pre?: boolean } | null };

export let fundableBlocked = false;
// One batched lookup; billed only for domains Fundable knows.
export function fundableByDomains(domains: string[]): FundableCo[] {
  const out: FundableCo[] = [];
  for (let i = 0; i < domains.length; i += 25) {
    const chunk = domains.slice(i, i + 25);
    try {
      out.push(...(monid("fundable", "/companies", { identifiers: { domains: chunk }, page_size: chunk.length }, "fundable_companies").companies ?? []));
    } catch (e: any) { console.log(`  ${e.message}`); fundableBlocked = true; break; }
  }
  return out;
}
