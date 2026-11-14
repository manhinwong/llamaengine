import { execFileSync } from "node:child_process";
import type { RawItem } from "./edgar.ts";

const gh = (args: string[]): any => JSON.parse(execFileSync("gh", ["api", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
const TOPICS = ["robotics", "llm", "agents", "ai", "machine-learning", "embodied-ai", "ai-security", "llm-security", "mcp"];
const iso = (d: Date) => d.toISOString().slice(0, 10);

// Live: repos < 60 days old, ranked by stars/day.
export async function githubStarVelocity(now = new Date(), minStars = 150): Promise<RawItem[]> {
  const since = iso(new Date(now.getTime() - 60 * 864e5));
  const out = new Map<string, RawItem>();
  for (const t of TOPICS) {
    let r: any;
    try {
      r = gh([`search/repositories?q=${encodeURIComponent(`created:>${since} stars:>${minStars} topic:${t}`)}&sort=stars&per_page=30`]);
    } catch { continue; }
    for (const repo of r.items ?? []) {
      const age = Math.max(1, (now.getTime() - Date.parse(repo.created_at)) / 864e5);
      const v = repo.stargazers_count / age;
      out.set(repo.full_name, {
        source: "github",
        signal_type: "star_velocity",
        url: repo.html_url,
        title: `${repo.full_name}: ${repo.stargazers_count} stars in ${Math.round(age)} days`,
        text: `${repo.description ?? ""} | owner=${repo.owner.login} (${repo.owner.type}) | homepage=${repo.homepage ?? ""} | ${v.toFixed(1)} stars/day | topics=${(repo.topics ?? []).join(",")}`,
        date: repo.created_at,
        label: "V",
        hint: { github: repo.owner.login, homepage: repo.homepage, stars_per_day: v },
      });
    }
  }
  return [...out.values()];
}

// Backtest: repos created in the 60 days before cutoff; star count AS OF cutoff from stargazer timestamps.
export async function githubAsOf(cutoff: Date, perTopic = 15, minAsOf = 100): Promise<{ items: RawItem[]; undated: number }> {
  const from = iso(new Date(cutoff.getTime() - 60 * 864e5));
  const to = iso(cutoff);
  const seen = new Set<string>();
  const items: RawItem[] = [];
  for (const t of TOPICS) {
    let r: any;
    try {
      r = gh([`search/repositories?q=${encodeURIComponent(`created:${from}..${to} stars:>300 topic:${t}`)}&sort=stars&per_page=${perTopic}`]);
    } catch { continue; }
    for (const repo of r.items ?? []) {
      if (seen.has(repo.full_name)) continue;
      seen.add(repo.full_name);
      // first 3 pages (300 stargazers) are enough to prove velocity before cutoff
      let asOf = 0;
      for (let page = 1; page <= 3; page++) {
        let sg: any[];
        try {
          sg = gh(["-H", "Accept: application/vnd.github.star+json", `repos/${repo.full_name}/stargazers?per_page=100&page=${page}`]);
        } catch { break; }
        asOf += sg.filter((s) => Date.parse(s.starred_at) <= cutoff.getTime()).length;
        if (sg.length < 100 || Date.parse(sg[sg.length - 1].starred_at) > cutoff.getTime()) break;
      }
      if (asOf < minAsOf) continue;
      const age = Math.max(1, (cutoff.getTime() - Date.parse(repo.created_at)) / 864e5);
      items.push({
        source: "github",
        signal_type: "star_velocity",
        url: repo.html_url,
        title: `${repo.full_name}: >=${asOf} stars within ${Math.round(age)} days of creation (as of cutoff)`,
        text: `${repo.description ?? ""} | owner=${repo.owner.login} (${repo.owner.type}) | homepage=${repo.homepage ?? ""} | topics=${(repo.topics ?? []).join(",")}`,
        date: repo.created_at,
        label: "V",
        hint: { github: repo.owner.login, homepage: repo.homepage },
      });
    }
  }
  return { items, undated: 0 };
}
