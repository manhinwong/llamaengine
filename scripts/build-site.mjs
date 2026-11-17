// Builds the static page into public/: bundles the page code and writes data.json from the bundled sample.
// MEMORY_API_URL, when set, points the page at the memory API in api/; without it votes stay in the browser.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(join(root, "node_modules/.bin/esbuild"), [join(root, "src/web/app.ts"), "--bundle", "--format=iife", "--target=es2020", `--outfile=${join(root, "public/app.js")}`], { stdio: "inherit" });
const data = JSON.parse(readFileSync(join(root, "sample/data.json"), "utf8"));
const api = (process.env.MEMORY_API_URL ?? "").replace(/\/$/, "");
data.memory_store = api ? { url: api, anon_key: "public", table: "feedback_events" } : null;
writeFileSync(join(root, "public/data.json"), JSON.stringify(data));
console.log(`site built, memory store: ${api || "browser only"}`);
