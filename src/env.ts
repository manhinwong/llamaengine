import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DATA = join(ROOT, "data");

const envPath = join(ROOT, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[2].trim()) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

export const need = (k: string): string => {
  const v = process.env[k];
  if (!v) {
    console.error(`Missing ${k} in .env`);
    process.exit(2);
  }
  return v;
};
export const PUBLIC_DEMO = process.env.PUBLIC_DEMO !== "false";
