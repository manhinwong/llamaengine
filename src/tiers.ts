// Source credibility tiers (v2 gate). The tier comes from where the record lives (URL host and path) and whose it is,
// never from the channel that happened to find it: a Telem result can be an SEC filing, a company page or a scraped profile.
//   primary     a record the company cannot simply write about itself: Form D, GitHub activity, an HN thread, an ATS job post, a paper
//   self        the company's own site or its social and launch posts: founder claims, at most one signal, never the second witness
//   aggregator  scraped profiles and directories: pointers only, never counted
//   third_party a LinkedIn or X post about the company by someone who is not the company or a known founder: counts as a second signal
//   unlisted    everything the spec does not name (press, press releases, accelerator pages, forums): not counted in the base rule
import type { Signal, Candidate } from "./store.ts";

export type Tier = "primary" | "self" | "third_party" | "aggregator" | "unlisted";
export type Tiered = { tier: Tier; family: string; host: string };

const ATS = /^(jobs\.ashbyhq\.com|jobs\.lever\.co|boards\.greenhouse\.io|job-boards\.greenhouse\.io|boards\.eu\.greenhouse\.io|apply\.workable\.com|jobs\.gem\.com|workatastartup\.com)$/;
const PAPER = /^(arxiv\.org|openreview\.net|aclanthology\.org|biorxiv\.org|proceedings\.mlr\.press|proceedings\.neurips\.cc)$/;
const SOCIAL: [RegExp, string][] = [[/(^|\.)linkedin\.com$/, "linkedin_post"], [/^(x\.com|twitter\.com)$/, "x_post"], [/(^|\.)producthunt\.com$/, "producthunt"], [/^(instagram\.com|youtube\.com|youtu\.be|medium\.com|kickstarter\.com)$|\.substack\.com$/, "own_channel"]];
const AGGREGATOR = /(^|\.)(dealroom\.co|tracxn\.com|crunchbase\.com|pitchbook\.com|cbinsights\.com|golden\.com|zoominfo\.com|rocketreach\.co|apollo\.io|owler\.com|craft\.co|startupintros\.com|f6s\.com|wellfound\.com|angel\.co|builtin\.com|builtinsf\.com|builtinnyc\.com|tealhq\.com|jaabz\.com|hackerfeeds\.com|alphaxiv\.org|finance\.yahoo\.com|baike\.baidu\.com|pomegra\.io|cosign\.co|intelatek\.co|vqv\.me|newmarketpitch\.com|dreamworkhq\.com|yespress\.io|gtmcofounder\.com|theorg\.com|signal\.nfx\.com|getlatka\.com|harmonic\.ai|extruct\.ai|parsers\.vc)$/;
const WIRE = /(^|\.)(businesswire\.com|prnewswire\.com|globenewswire\.com|einpresswire\.com|accesswire\.com|newswire\.com)$/;
const PRESS = /(^|\.)(techcrunch\.com|forbes\.com|businessinsider\.com|fortune\.com|theinformation\.com|bloomberg\.com|wsj\.com|reuters\.com|venturebeat\.com|wired\.com|theverge\.com|axios\.com|tech\.eu|eu-startups\.com|sifted\.eu|techfundingnews\.com|therobotreport\.com|upstartsmedia\.com|runtimewire\.com|robots-blog\.com|siliconangle\.com|geekwire\.com|cnbc\.com|ft\.com|nytimes\.com|aimagazine\.com|techbuzz\.ai|mlq\.ai|en\.wowtale\.net|americanbazaaronline\.com|cryptobriefing\.com)$/;
// Accelerators and fellowships whose cohorts most funds already track.
const ACCELERATOR_HOST = /(^|\.)(ycombinator\.com|workatastartup\.com|southparkcommons\.com|techstars\.com|antler\.co|joinef\.com|neo\.com|hf0\.com|pioneer\.app|speedrun\.a16z\.com|500\.co|alchemistaccelerator\.com)$/;
const YC_TEXT = /\bLaunch HN\b|\bY ?Combinator\b|\bYC ?[WSFX] ?\d{2}\b|\(YC\b|\bYC[- ]backed\b/i;
const OTHER_ACC_TEXT = /\bTechstars\b|\ba16z speedrun\b|\bSouth Park Commons\b|\bEntrepreneur First\b|\bAntler\b|\bHF0\b|\bNeo Accelerator\b/i;

export const hostOf = (u: string) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
const pathOf = (u: string) => { try { return new URL(u).pathname; } catch { return ""; } };
const ownHost = (h: string, c: Candidate) => c.domains.some((d) => h === d || h.endsWith("." + d));

// Who wrote a LinkedIn or X post, read from its URL, compared with the company and its known founders.
//   own          the company's page or handle, or a known founder
//   third_party  someone else, when we know who the founders are
//   feed         an account that reposts news (not a witness)
//   unknown      no founder names on file, so the author cannot be ruled out as a founder: treated as self-published
const squash = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, "");
const FEED = /news|reporter|daily|digest|curation|wire|media|times|clock|pulse|insider|buzz|bulletin|updates?$/;
export function postAuthor(s: Signal, c: Candidate): "own" | "third_party" | "feed" | "unknown" | null {
  const host = hostOf(s.url), path = pathOf(s.url);
  let slug: string | null = null;
  if (/(^|\.)linkedin\.com$/.test(host)) {
    const m = path.match(/^\/(posts|in|company|pulse)\/([^/_]+)/);
    if (!m) return null;
    if (m[1] === "company") return "own";
    slug = m[2];
  } else if (/^(x\.com|twitter\.com)$/.test(host)) {
    slug = path.split("/")[1] ?? null;
  } else return null;
  if (!slug) return null;
  const a = squash(slug.replace(/-[0-9a-f]{6,}$/i, ""));
  const company = [squash(c.name), ...c.domains.map((d) => squash(d.split(".")[0])), ...c.linkedin.map((l) => squash(l.replace(/^(company|in)\//, "")))].filter((x) => x.length >= 3);
  if (company.some((x) => a === x || (x.length >= 5 && a.includes(x)))) return "own";
  const people = c.people.map((p) => p.toLowerCase().split(/\s+/).filter((t) => t.length >= 2)).filter((t) => t.length >= 2);
  if (people.some((t) => a.includes(t[0].replace(/[^a-z]/g, "")) && a.includes(t[t.length - 1].replace(/[^a-z]/g, "")))) return "own";
  if (FEED.test(slug.toLowerCase())) return "feed";
  return people.length ? "third_party" : "unknown";
}

export function tierOf(s: Signal, c: Candidate): Tiered {
  const host = hostOf(s.url), path = pathOf(s.url), src = s.source.split(":")[0];
  const t = (tier: Tier, family: string): Tiered => ({ tier, family, host });
  // news.ycombinator.com is Hacker News, not the YC directory: match it first.
  if (host === "news.ycombinator.com" || src === "hn") return t("primary", "hn");
  if (host === "sec.gov" || host.endsWith(".sec.gov") || src === "edgar_formd") return t("primary", "form_d");
  if (host === "github.com" || src === "github") return t("primary", "github");
  if (ATS.test(host) || (/(^|\.)ycombinator\.com$/.test(host) && /^\/companies\/[^/]+\/jobs/.test(path))) return t("primary", "ats_job");
  if (PAPER.test(host)) return t("primary", "paper");
  if (host && ownHost(host, c)) return t("self", "own_site");
  const author = postAuthor(s, c);
  if (author === "third_party") return t("third_party", "third_party_post");
  if (author === "feed") return t("aggregator", "news_feed_post");
  for (const [re, fam] of SOCIAL) if (re.test(host)) return t("self", fam);
  if (ACCELERATOR_HOST.test(host)) return t("unlisted", "accelerator_page");
  if (AGGREGATOR.test(host)) return t("aggregator", "aggregator");
  if (WIRE.test(host)) return t("unlisted", "press_release");
  if (PRESS.test(host)) return t("unlisted", "press");
  if (/(^|\.)(reddit\.com|dev\.to|discourse\.[a-z]+\.org)$/.test(host)) return t("unlisted", "forum");
  return t("unlisted", "other_web");
}

// Is this primary record tied to the company by a hard identifier (website, LinkedIn URL, GitHub handle), or only by a shared name?
export function hardLinked(s: Signal, c: Candidate): boolean {
  const d = (s.domain ?? "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  const g = (s.github ?? "").toLowerCase().replace(/^https?:\/\/github\.com\//, "").split("/")[0];
  const l = (s.linkedin ?? "").toLowerCase().replace(/^https?:\/\/(www\.)?linkedin\.com\//, "").replace(/\/$/, "");
  return (!!d && c.domains.includes(d)) || (!!g && c.github.includes(g)) || (!!l && c.linkedin.includes(l)) || ownHost(hostOf(s.url), c);
}

export type GateOpts = { selfCounts?: boolean; pressCounts?: boolean; acceleratorCounts?: boolean; thirdPartyAlone?: boolean; thirdPartyNever?: boolean; trust?: (s: Signal) => boolean };
// Base rule: two signals from different families, at least one primary. The second can be another primary family,
// one self-published signal, or a third-party post. Aggregators, news feeds and unlisted sources never count.
// `trust` drops records that should not count toward the verified gate (for example a lookup hit matched on name only).
export function gateV2(sigs: Signal[], c: Candidate, o: GateOpts = {}) {
  const selfCounts = o.selfCounts ?? true;
  const tiers = sigs.filter((s) => o.trust?.(s) ?? true).map((s) => ({ s, ...tierOf(s, c) }));
  const primary = [...new Set(tiers.filter((x) => x.tier === "primary").map((x) => x.family))];
  // thirdPartyNever reproduces the first v2 pass, where every social post was treated as self-published.
  const hasSelf = tiers.some((x) => x.tier === "self" || (o.thirdPartyNever && x.tier === "third_party"));
  const hasThird = !o.thirdPartyNever && tiers.some((x) => x.tier === "third_party");
  const extra = hasThird || (o.pressCounts && tiers.some((x) => x.family === "press")) || (o.acceleratorCounts && tiers.some((x) => x.family === "accelerator_page"));
  const second = primary.length >= 2 ? primary[1] : selfCounts && hasSelf ? "self" : extra ? "third_party" : null;
  const pass = (primary.length >= 1 && second !== null) || (!!o.thirdPartyAlone && hasThird && hasSelf);
  const pair = !pass ? null : !primary.length ? "self + third_party_post" : [primary[0], primary.length >= 2 ? primary[1] : second === "self" ? `self:${tiers.find((x) => x.tier === "self" || x.tier === "third_party")!.family}` : hasThird ? "third_party_post" : second].sort().join(" + ");
  const reason = pass ? `primary ${primary.join(", ")}${primary.length >= 2 ? "" : ` with ${second === "self" ? "one self-published signal" : "a third-party report"}`}` : primary.length ? `one primary record (${primary[0]}) and no second signal` : hasSelf ? "self-published only, no primary record" : "no primary record";
  return { pass, pair, reason, primary, hasSelf, hasThird, tiers };
}

export function widelySeen(sigs: Signal[], c: Candidate): { yc: boolean; other: boolean } {
  // Titles and summaries only: a Hacker News URL contains "ycombinator" and must not tag a company as YC.
  const text = sigs.map((s) => `${s.title ?? ""} ${s.text ?? ""}`).join(" ") + " " + ((c as any).raised?.round ?? "");
  const ycHost = sigs.some((s) => /(^|\.)(ycombinator\.com|workatastartup\.com)$/.test(hostOf(s.url)) && hostOf(s.url) !== "news.ycombinator.com");
  const yc = ycHost || YC_TEXT.test(text);
  const other = sigs.some((s) => ACCELERATOR_HOST.test(hostOf(s.url)) && !/(ycombinator|workatastartup)\.com$/.test(hostOf(s.url))) || OTHER_ACC_TEXT.test(text);
  return { yc, other };
}
