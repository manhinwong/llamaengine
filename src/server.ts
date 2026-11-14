import { createServer } from "node:http";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT } from "./env.ts";
import { read, write, type Feedback } from "./store.ts";
import { buildData } from "./export.ts";
import { REASONS } from "./rank.ts";

const PUB = join(ROOT, "public");
const bundle = () => execFileSync(join(ROOT, "node_modules/.bin/esbuild"), [join(ROOT, "src/web/app.ts"), "--bundle", "--format=iife", "--target=es2020", `--outfile=${join(PUB, "app.js")}`], { stdio: "inherit" });

if (process.argv[2] === "export") {
  // Static bundle for hosting: index.html + app.js + data.json. Feedback then lives in the browser.
  bundle();
  mkdirSync(PUB, { recursive: true });
  writeFileSync(join(PUB, "data.json"), JSON.stringify(buildData()));
  console.log("exported public/data.json");
  process.exit(0);
}

bundle();
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".css": "text/css" };
const json = (res: any, code: number, body: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  // A fresh clone has no store yet: serve the bundled sample so the page works without any keys.
  if (url.pathname === "/data.json") return json(res, 200, existsSync(join(ROOT, "data", "candidates.json")) ? buildData() : JSON.parse(readFileSync(join(ROOT, "sample", "data.json"), "utf8")));
  if (url.pathname === "/api/feedback" && req.method === "GET") return json(res, 200, read<Feedback[]>("feedback"));
  if (url.pathname === "/api/feedback" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const b = JSON.parse(body);
      if (!/^[A-Za-z0-9]{1,20}$/.test(String(b.investor)) || ![1, -1].includes(b.vote) || typeof b.candidate_id !== "string" || !(b.reason in REASONS)) return json(res, 400, { error: "bad feedback" });
      const all = read<Feedback[]>("feedback"); // raw events, append-only
      all.push({ investor: b.investor, candidate_id: b.candidate_id, vote: b.vote, reason: b.reason, at: new Date().toISOString() });
      write("feedback", all);
      return json(res, 200, all);
    } catch { return json(res, 400, { error: "bad json" }); }
  }
  if (url.pathname === "/api/feedback" && req.method === "DELETE") { write("feedback", []); return json(res, 200, []); }
  const file = join(PUB, url.pathname === "/" ? "index.html" : url.pathname.replace(/\.\./g, ""));
  if (!existsSync(file)) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}).listen(Number(process.env.PORT ?? 4173), () => console.log(`sourcing engine UI on http://localhost:${process.env.PORT ?? 4173}`));
