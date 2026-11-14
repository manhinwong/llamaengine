import { rank, learned, compare, PERSONAS, REASONS } from "../rank.ts";
import type { Feedback, Candidate, Score } from "../store.ts";

type Data = any;
let data: Data;
let feedback: Feedback[] = [];
let investor = "A";
let prevOrder: Record<string, string[]> = {};
let open = new Set<string>();
let pending: { id: string; vote: 1 | -1 } | null = null;
let lang: "en" | "cn" = (navigator.language || "en").toLowerCase().startsWith("zh") ? "cn" : "en";

const $ = (s: string) => document.querySelector(s) as HTMLElement;
const T = (en: string, cn: string) => (lang === "cn" ? cn : en);
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
const num = (n: number) => n.toLocaleString("en-US");

const CN: Record<string, string> = {
  robotics: "机器人", hardware: "硬件", software_for_hardware: "硬件软件", ai_infra: "AI 基础设施", ai_app: "AI 应用", dev_tools: "开发者工具", other: "其他",
  launch_post: "发布公告", hiring: "招聘", show_hn: "Show HN", paper: "论文", left_job: "离职创业", cohort: "孵化器名单", form_d: "Form D", star_velocity: "Star 增速", linkedin_post: "LinkedIn 帖子", x_post: "X 帖子", producthunt: "Product Hunt", web_mention: "网络佐证", lab_roster_change: "实验室名单变动", title_change: "职位变更",
  founder_market_fit: "创始人与市场匹配", tech_traction: "技术进展", identity: "个人特质", seed_person: "种子名单人物",
  love_space: "看好赛道", love_founder: "看好创始人", wrong_sector: "赛道不符", too_late: "太晚了", weak_founder_fit: "创始人匹配弱", not_ai_native: "非 AI 原生",
  "Investor A": "投资人 A", "Investor B": "投资人 B", "Investor C": "投资人 C", security: "安全与验证",
  "Verification and security for AI agents and AI-written code": "AI Agent 与 AI 代码的验证与安全",
  proves_by_running: "以实际运行证明", agent_runtime_controls: "Agent 运行时管控", code_verification: "AI 代码验证", open_source: "开源", works_across_agents: "跨 Agent 通用", telem_discover: "Telem 路由搜索发现",
  "Robotics and hardware, research lineage": "机器人与硬件，重研究背景", "AI infrastructure and developer tools, open-source pull": "AI 基础设施与开发者工具，重开源势能",
  stealth_launch: "隐身期发布", founding_engineer: "创始工程师招聘", arxiv_spinout: "arXiv 论文转创业", left_to_start: "离职创业", hardware_stealth: "硬件隐身期招聘", accelerator_cohort: "孵化器新批次", arxiv_seed: "种子名单论文",
  telem_linkedin: "Telem · LinkedIn 帖子", telem_x: "Telem · X", telem_producthunt: "Telem · Product Hunt", telem_monitor: "Telem Monitors", telem_search: "Telem 搜索佐证", tavily_map: "Tavily Map 差异", edgar_formd: "SEC Form D", github: "GitHub Star 增速", hn: "Show HN",
  telem: "Telem", tavily: "Tavily", claude: "Claude", monid: "Monid",
};
const EN: Record<string, string> = { robotics: "Robotics", hardware: "Hardware", software_for_hardware: "Software for hardware", security: "Security and verification", ai_infra: "AI infrastructure", ai_app: "AI applications", dev_tools: "Developer tools", other: "Other", launch_post: "Launch post", hiring: "First hires", show_hn: "Show HN", paper: "Paper", left_job: "Left to start a company", star_velocity: "GitHub star velocity", form_d: "SEC Form D", linkedin_post: "LinkedIn post", x_post: "X post", producthunt: "Product Hunt", cohort: "Accelerator cohort", web_mention: "Web mention", proves_by_running: "Proves by running", agent_runtime_controls: "Agent runtime controls", code_verification: "AI-code verification", open_source: "Open source", works_across_agents: "Works across agents", telem_linkedin: "Telem · LinkedIn posts", telem_x: "Telem · X", telem_producthunt: "Telem · Product Hunt", telem_monitor: "Telem Monitors", telem_search: "Telem search corroboration", telem_discover: "Telem routed discovery", tavily_map: "Tavily Map diff", edgar_formd: "SEC Form D", github: "GitHub star velocity", hn: "Show HN", telem: "Telem", tavily: "Tavily", claude: "Claude", monid: "Monid" };
const word = (k: string) => (lang === "cn" ? CN[k] ?? k.replace(/_/g, " ") : EN[k] ?? REASONS[k]?.label ?? k.replace(/_/g, " "));
const feat = (k: string): string => (k === "lower bound" ? T("Lower bound", "保守下界") : k.startsWith("standout:") ? `${T("Standout", "突出项")}: ${(data.dims.find((d: any) => d.key === k.slice(9))?.label && lang !== "cn" ? data.dims.find((d: any) => d.key === k.slice(9)).label : word(k.slice(9))).toLowerCase()}` : word(k.replace(/^(sector|signal|dim|seed|tag):/, "")));
const LABEL = () => ({ F: T("Founder claim", "创始人自述"), V: T("Verified record", "已核实记录"), A: T("Agent inference", "模型推断") }) as Record<string, string>;

const ICON = {
  up: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 9l3.2-6.2c1.3 0 2.3 1 2.3 2.3V8h3.3c1 0 1.8.9 1.6 1.9l-1 5.4c-.2.9-1 1.5-1.9 1.5H7V9zm-1.5 0H3v7.8h2.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
  down: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M13 11l-3.2 6.2c-1.3 0-2.3-1-2.3-2.3V12H4.2c-1 0-1.8-.9-1.6-1.9l1-5.4c.2-.9 1-1.5 1.9-1.5H13v7.8zm1.5 0H17V3.2h-2.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
};

// Investor memory. Three stores, best available first:
//   shared  - InsForge table of raw feedback events (append-only), scoped to a "memory space" named in the URL hash, so a link carries the memory to any device
//   server  - the local dev server's events file
//   browser - localStorage
let store: "shared" | "server" | "browser" = "browser";
let space = "main";
const mem = () => data.memory_store as { url: string; anon_key: string; table: string } | null;
const memHeaders = () => ({ Authorization: `Bearer ${mem()!.anon_key}`, "Content-Type": "application/json" });
async function loadFeedback() {
  if (mem()) {
    try {
      const fromHash = location.hash.match(/m=([a-z0-9]{4,20})/)?.[1];
      let saved: string | null = null;
      try { saved = localStorage.getItem("space"); } catch {}
      // Each browser gets its own memory space on first visit, so one visitor's votes never change another's ranking.
      // Opening a shared link (#m=...) joins that space on purpose.
      space = fromHash ?? saved ?? (Math.random().toString(36) + "00000000").slice(2, 10);
      if (space !== saved) try { localStorage.setItem("space", space); } catch {}
      const r = await fetch(`${mem()!.url}/api/database/records/${mem()!.table}?session=eq.${space}&order=at.asc&limit=1000`, { headers: memHeaders() });
      if (!r.ok) throw new Error();
      feedback = await r.json();
      store = "shared";
      return;
    } catch {}
  }
  try {
    const r = await fetch("/api/feedback");
    if (!r.ok) throw new Error();
    feedback = await r.json();
    store = "server";
  } catch {
    store = "browser";
    try { feedback = JSON.parse(localStorage.getItem("feedback") ?? "[]"); } catch { feedback = []; }
  }
}
async function sendFeedback(ev: Omit<Feedback, "at">) {
  if (store === "shared") {
    const r = await fetch(`${mem()!.url}/api/database/records/${mem()!.table}`, { method: "POST", headers: { ...memHeaders(), Prefer: "return=representation" }, body: JSON.stringify([{ ...ev, session: space }]) });
    if (r.ok) feedback.push(...(await r.json()));
  } else if (store === "server") {
    const r = await fetch("/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ev) });
    feedback = await r.json();
  } else {
    feedback.push({ ...ev, at: new Date().toISOString() });
    try { localStorage.setItem("feedback", JSON.stringify(feedback)); } catch {}
  }
}
async function resetFeedback() {
  if (store === "shared") {
    // Events are append-only. "Reset" opens a fresh memory space; the old one stays in the table.
    space = Math.random().toString(36).slice(2, 10);
    try { localStorage.setItem("space", space); } catch {}
    history.replaceState(null, "", `#m=${space}`);
  } else if (store === "server") await fetch("/api/feedback", { method: "DELETE" });
  else try { localStorage.removeItem("feedback"); } catch {}
  feedback = [];
  prevOrder = {};
  render();
}

function memoryPanel() {
  const mine = feedback.filter((f) => f.investor === investor);
  if (!PERSONAS[investor]) return "";
  const name = word(PERSONAS[investor].name);
  const where = store === "shared" ? T(`Private to this browser, stored as append-only events · <button class="link inline" data-share="1">Copy a link to share this memory</button>`, `仅此浏览器可见，以只追加事件存储 · <button class="link inline" data-share="1">复制链接以共享此记忆</button>`) : store === "server" ? T("Stored on the local server as append-only events", "以只追加事件存于本地服务器") : T("Stored in this browser only", "仅存于此浏览器");
  if (!mine.length) return `<div class="memory empty-mem"><h3>${T(`What the engine has learned about ${name}`, `引擎对${name}的了解`)}</h3><p class="fine">${T("Nothing yet. Vote on a company with a reason; the reason decides which preferences move, and the list re-ranks at once.", "暂无。对任一公司投票并选择理由；理由决定调整哪些偏好，名单随即重排。")} ${where}.</p></div>`;
  const L = learned(investor, data.candidates, data.scores, feedback).slice(0, 8);
  const max = Math.max(...L.map((x) => Math.abs(x.points)), 1);
  const names = new Map(data.candidates.map((c: Candidate) => [c.id, nameOf(c)]));
  const rows = L.map((x) => `<div class="lrow"><span class="lname">${esc(feat(x.feature))}</span><span class="lbar"><i class="${x.points < 0 ? "neg" : "pos"}" style="width:${Math.round((Math.abs(x.points) / max) * 100)}%"></i></span><span class="m lval">${x.points > 0 ? "+" : ""}${x.points} ${T("pts", "分")}</span></div>`).join("");
  const recent = mine.slice(-4).reverse().map((f) => `<li>${f.vote > 0 ? ICON.up : ICON.down}<b>${esc(names.get(f.candidate_id) ?? f.candidate_id)}</b> · ${esc(word(f.reason))}</li>`).join("");
  return `<div class="memory"><h3>${T(`What the engine has learned about ${name}`, `引擎对${name}的了解`)}</h3>
    <div class="memgrid"><div>${rows || `<p class="fine">${T("Votes so far have not shifted any preference.", "目前的投票尚未改变任何偏好。")}</p>`}<p class="fine">${T("Points a fully matching company now gains or loses for this investor, compared with the starting profile.", "与初始画像相比，完全匹配的公司现在对该投资人增加或减少的分数。")}</p></div>
    <div><ul class="recent">${recent}</ul><p class="fine">${mine.length} ${T(mine.length === 1 ? "event" : "events", "条反馈")}. ${where}.</p></div></div></div>`;
}

function dimRow(d: any, s: Score) {
  const v = s.dims[d.key];
  const lv = v?.level ?? "U";
  const pips = [1, 2, 3, 4, 5].map((i) => `<i class="${typeof lv === "number" && i <= lv ? "on" : ""}"></i>`).join("");
  const claims = (v?.claims ?? []).map((c: any) => `<li><span class="tag t${c.label}" title="${LABEL()[c.label]}">${c.label}</span><span>${esc(c.text)} <a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(host(c.url))}</a></span></li>`).join("");
  return `<div class="dim ${lv === "U" ? "unknown" : ""}">
    <div class="dimhead"><span class="dimname">${esc(lang === "cn" ? CN[d.key] ?? d.label : d.label)}</span>${lv === "U" ? `<span class="ubadge">U · ${T("unknown before contact", "接触前未知")}</span>` : `<span class="pips">${pips}<em>${lv}/5</em></span>`}</div>
    ${lv !== "U" && v?.rationale ? `<p>${esc(v.rationale)}</p>` : ""}${claims ? `<ul class="claims">${claims}</ul>` : ""}</div>`;
}

function row(r: ReturnType<typeof rank>[number], i: number, moved: number) {
  const c: Candidate = r.candidate, s: Score = r.score;
  const isOpen = open.has(c.id);
  const sigs = c.signal_ids.map((id) => data.signals[id]).filter(Boolean);
  const why = r.why.map((w) => `<span class="why ${w.points < 0 ? "neg" : ""}">${esc(feat(w.feature))}<b>${w.points > 0 && w.feature !== "lower bound" ? "+" : ""}${w.points}</b></span>`).join("");
  const voted = r.voted ? `<span class="voted ${r.voted.vote > 0 ? "pos" : "neg"}">${r.voted.vote > 0 ? ICON.up : ICON.down}${esc(word(r.voted.reason))}</span>` : "";
  const reasonPick = pending?.id === c.id
    ? `<div class="reasons"><span class="eyebrow">${pending.vote > 0 ? T("Why yes", "看好的原因") : T("Why not", "不看好的原因")}</span>${Object.keys(REASONS).filter((k) => (pending!.vote > 0 ? k.startsWith("love") : !k.startsWith("love"))).map((k) => `<button class="pill" data-reason="${k}" data-id="${c.id}">${esc(word(k))}</button>`).join("")}<button data-cancel="1" class="link">${T("Cancel", "取消")}</button></div>` : "";
  const shown = isOpen ? sigs : sigs.slice(0, 3);
  return `<article class="row ${isOpen ? "open" : ""}">
    <div class="rk"><span class="n">${String(i + 1).padStart(2, "0")}</span>${moved ? `<span class="move ${moved > 0 ? "up" : "down"}">${moved > 0 ? "▲" : "▼"} ${Math.abs(moved)}</span>` : ""}</div>
    <div class="body">
      <div class="head">
        <h3>${esc(nameOf(c))}</h3>
        <span class="sector">${esc(word(c.sector))}</span>
        ${c.domains[0] && !blind ? `<a class="site" href="https://${esc(c.domains[0])}" target="_blank" rel="noopener">${esc(c.domains[0])}</a>` : ""}
        ${c.raised && c.status === "digest" ? `<span class="stated" title="${esc(c.raised.source)}">${T("stated", "自述")}: ${esc(c.raised.round)}</span>` : ""}
        ${voted}
      </div>
      <div class="whyrow"><span class="eyebrow">${T("Why ranked here", "排序依据")}</span>${why}</div>
      <ul class="sigs">${shown.map((x: any) => `<li><span class="tag t${x.label}" title="${LABEL()[x.label]}">${x.label}</span>${blind ? `<span>${esc(word(x.signal_type))} · ${esc(word(x.source.split(":")[0]))}</span>` : `<a href="${esc(x.url)}" target="_blank" rel="noopener" title="${esc(x.text)}">${esc(word(x.signal_type))} · ${esc(host(x.url))}</a>`}<time>${x.date ? esc(x.date.slice(0, 10)) : T("undated", "无日期")}</time></li>`).join("")}${!isOpen && sigs.length > 3 ? `<li class="more">+ ${sigs.length - 3} ${T("more", "条")}</li>` : ""}</ul>
      ${isOpen ? `<div class="dims">${data.dims.map((d: any) => dimRow(d, blind ? ({ ...s, dims: Object.fromEntries(Object.entries(s.dims).map(([k, v]: [string, any]) => [k, { ...v, rationale: "", claims: [] }])) } as Score) : s)).join("")}${blind ? `<p class="fine">${T("Evidence text is hidden while names are hidden.", "隐藏名称时，证据文字同时隐藏。")}</p>` : ""}</div>` : ""}
      ${reasonPick}
    </div>
    <div class="scorecol">
      <div class="lb" title="P + (100 − C) / 5">${s.lower.toFixed(1)}</div>
      <div class="bar" title="${s.lower} – ${s.upper}"><span style="left:${s.lower}%;width:${Math.max(1.5, s.upper - s.lower)}%"></span></div>
      <dl><div><dt>${T("Interval", "区间")}</dt><dd>${s.lower}–${s.upper}</dd></div><div><dt>${T("Coverage", "覆盖率")}</dt><dd>${Math.round(s.C)}%</dd></div><div><dt>${T("Fit", "偏好")}</dt><dd>${r.fit >= 0 ? "+" : ""}${r.fit}</dd></div></dl>
      <div class="actions">
        <button class="icon" data-vote="1" data-id="${c.id}" aria-label="${T("Thumbs up", "看好")}">${ICON.up}</button>
        <button class="icon" data-vote="-1" data-id="${c.id}" aria-label="${T("Thumbs down", "不看好")}">${ICON.down}</button>
        <button class="link" data-toggle="${c.id}">${isOpen ? T("Hide detail", "收起") : T("Score detail", "评分详情")}</button>
      </div>
    </div>
  </article>`;
}

function backtest() {
  const b = data.backtest;
  if (!b) return `<p class="muted">${T("No backtest run yet.", "尚未运行回测。")}</p>`;
  const pct = (x: number | null) => (x == null ? "–" : (x * 100).toFixed(1) + "%");
  const block = (title: string, x: any) => `<div class="bt">
      <h3>${title}</h3>
      <div class="stats small"><div><b>${x.hits}</b><span>${T(`caught, of ${x.size} surfaced`, `命中 / 共 ${x.size} 家`)}</span></div><div><b>${x.median_lead_days ?? "–"}</b><span>${T("median lead, days", "领先天数中位数")}</span></div><div><b>${pct(x.recall)}</b><span>${T("recall vs key sample", "召回率（样本）")}</span></div><div><b>${pct(x.precision_lower_bound)}</b><span>${T("precision, lower bound", "精确率下界")}</span></div></div>
      ${x.companies?.length ? `<div class="tablewrap"><table><thead><tr><th>${T("Company", "公司")}</th><th>${T("Round", "轮次")}</th><th>${T("First signal", "首个信号")}</th><th>${T("Announced", "官宣")}</th><th class="r">${T("Lead", "领先")}</th><th>${T("Evidence", "证据")}</th></tr></thead><tbody>${x.companies.map((h: any) => `<tr><td><b>${esc(h.company)}</b></td><td>${esc(h.round)}</td><td class="m">${esc(h.first_signal)}</td><td class="m">${esc(h.announced)}</td><td class="m r">${h.lead_days}d</td><td>${(h.evidence ?? []).filter(Boolean).slice(0, 2).map((u: string) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(host(u))}</a>`).join(", ")}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">${T("No later-announced company in this set.", "该集合中没有后续官宣融资的公司。")}</p>`}
    </div>`;
  return `<p class="lede">${T(`The engine's own queries were run as of <b>${esc(b.cutoff)}</b> with no company names, on signals dated ${esc(b.window)}. The answer key is ${b.answer_key.size} AI pre-seed and seed rounds announced after that date.`, `以 <b>${esc(b.cutoff)}</b> 为截止日运行引擎自身的查询，不输入任何公司名，只用 ${esc(b.window)} 期间有日期的信号。答案集为截止日之后官宣的 ${b.answer_key.size} 笔 AI 种子前与种子轮。`)}</p>
    ${block(T("Shortlist, after the two-signal gate", "入围名单（通过双信号门槛）"), b.shortlist)}
    ${block(T("All resolved companies, before the gate", "全部已归并公司（门槛前）"), b.ungated_pool)}
    <p class="fine">${T(`Of ${num(b.dating.telem_results)} Telem results, ${num(b.dating.telem_undated_dropped)} had no publish date and were dropped. Precision is a lower bound: a company that has not announced may still be a good one. ${esc(b.answer_key.note)}`, `${num(b.dating.telem_results)} 条 Telem 结果中有 ${num(b.dating.telem_undated_dropped)} 条没有发布日期，已剔除。精确率为下界：尚未官宣的公司仍可能是好公司。答案集为抽样，召回率仅相对样本而言。`)} ${esc(b.dating.github_note ?? "")}</p>`;
}

function machinery() {
  const c = data.counts;
  const src = Object.entries(c.by_source).sort((a: any, b: any) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(word(k))}</td><td class="m r">${num(v as number)}</td></tr>`).join("");
  const spendRows = Object.entries(data.spend).sort((a: any, b: any) => b[1] - a[1]);
  const total = spendRows.reduce((a, [, v]) => a + (v as number), 0);
  const raised = data.candidates.filter((x: Candidate) => x.status === "already_raised");
  return `<div class="cols">
    <div class="col wide">
      <h3>${T("Telem Monitors", "Telem Monitors")}</h3>
      <div class="tablewrap"><table><thead><tr><th>${T("Monitor", "监控")}</th><th>${T("Watching for", "监控内容")}</th><th class="r">${T("Seq cursor", "seq 游标")}</th></tr></thead><tbody>
      ${data.monitors.map((m: any) => `<tr><td><b>${esc(word(m.key))}</b></td><td>${esc(m.query)}${m.include_domains.length ? `<span class="domains">${m.include_domains.map(esc).join(" · ")}</span>` : ""}</td><td class="m r">${m.cursor}</td></tr>`).join("")}
      </tbody></table></div>
      <p class="fine">${T("LinkedIn posts, X and Product Hunt run as scheduled pinned Telem searches and are diffed in our own store, because monitors take no provider pin.", "LinkedIn 帖子、X 和 Product Hunt 以定时的指定来源 Telem 搜索运行，并在自有存储中做差异比对，因为 Monitor 不支持指定来源。")}</p>
    </div>
    <div class="col">
      <h3>${T("Signals by source", "信号来源")}</h3>
      <table><tbody>${src}</tbody></table>
      <h3 class="gap">${T("Spend so far", "累计花费")}</h3>
      <table><tbody>${spendRows.map(([k, v]) => `<tr><td>${esc(word(k))}</td><td class="m r">$${(v as number).toFixed(2)}</td></tr>`).join("")}<tr class="total"><td>${T("Total", "合计")}</td><td class="m r">$${total.toFixed(2)}</td></tr></tbody></table>
      <p class="fine">${c.digest ? T(`$${(total / c.digest).toFixed(2)} per digest company, from list prices.`, `按公开价估算，每家入选公司 $${(total / c.digest).toFixed(2)}。`) : ""}</p>
      ${raised.length ? `<h3 class="gap">${T("Already raised", "已融资")}</h3><table><tbody>${raised.slice(0, 12).map((x: Candidate) => `<tr><td>${esc(nameOf(x))}</td><td class="m r">${esc((x.raised?.round ?? "").slice(0, 28))}</td></tr>`).join("")}</tbody></table>` : ""}
    </div>
  </div>`;
}

// ---- Open (non-branded) mode: investors are made by the people using the page ----
const neutral = () => data?.brand === "neutral";
let blind = false;
let onboarding = false;
type Prefs = { sectors: string[]; avoid: string[]; signals: string[]; tags: string[]; dims: Record<string, number> };
type Profile = { id: string; name: string; prefs: Prefs };
let profiles: Profile[] = [];
const SECTORS = ["robotics", "hardware", "software_for_hardware", "security", "ai_infra", "ai_app", "dev_tools"];
const SIGNALS = ["launch_post", "hiring", "show_hn", "paper", "left_job", "star_velocity", "form_d", "linkedin_post", "cohort"];
const TAGS = ["proves_by_running", "agent_runtime_controls", "code_verification", "open_source", "works_across_agents"];
const blankDraft = () => ({ name: "", sectors: [] as string[], avoid: [] as string[], signals: [] as string[], tags: [] as string[], dims: Object.fromEntries((data?.dims ?? []).map((d: any) => [d.key, 12.5])) as Record<string, number> });
let draft = blankDraft();

// Company names can be hidden so a list is judged on evidence and score alone.
let blindIx = new Map<string, number>();
const nameOf = (c: { id: string; name: string }) => (blind ? `${T("Company", "公司")} ${String((blindIx.get(c.id) ?? 0) + 1).padStart(2, "0")}` : c.name);

function personaFrom(p: Profile) {
  const w: Record<string, number> = {};
  for (const x of p.prefs.sectors) w[`sector:${x}`] = 6; // a chosen sector should lead the list even when rubric weights spread scores widely
  for (const x of p.prefs.avoid) w[`sector:${x}`] = -2;
  for (const x of p.prefs.signals) w[`signal:${x}`] = 0.6;
  for (const x of p.prefs.tags) w[`tag:${x}`] = 1;
  return { name: p.name, blurb: p.prefs.sectors.length ? p.prefs.sectors.map((x) => word(x)).join(", ") : T("No sector preference", "无赛道偏好"), weights: w, dimWeights: p.prefs.dims };
}
function registerProfiles() {
  for (const k of Object.keys(PERSONAS)) delete PERSONAS[k];
  for (const p of profiles) PERSONAS[p.id] = personaFrom(p);
}
async function loadProfiles() {
  profiles = [];
  if (store === "shared") {
    try {
      const r = await fetch(`${mem()!.url}/api/database/records/profiles?space=eq.${space}&order=at.asc&limit=500`, { headers: memHeaders() });
      if (r.ok) { const latest = new Map<string, Profile>(); for (const row of await r.json()) latest.set(row.profile_id, { id: row.profile_id, name: row.name, prefs: row.prefs }); profiles = [...latest.values()]; }
    } catch {}
  } else {
    try { profiles = JSON.parse(localStorage.getItem("profiles") ?? "[]"); } catch {}
  }
  registerProfiles();
  let me: string | null = null;
  try { me = localStorage.getItem("me"); } catch {}
  investor = profiles.find((p) => p.id === me)?.id ?? profiles[0]?.id ?? "";
  onboarding = !profiles.length;
}
async function createProfile() {
  const p: Profile = { id: "u" + Math.random().toString(36).slice(2, 9), name: draft.name.trim().slice(0, 40) || `${T("Investor", "投资人")} ${profiles.length + 1}`, prefs: { sectors: draft.sectors, avoid: draft.avoid.filter((x) => !draft.sectors.includes(x)), signals: draft.signals, tags: draft.tags, dims: draft.dims } };
  if (store === "shared") await fetch(`${mem()!.url}/api/database/records/profiles`, { method: "POST", headers: memHeaders(), body: JSON.stringify([{ profile_id: p.id, space, name: p.name, prefs: p.prefs }]) });
  profiles.push(p);
  if (store !== "shared") try { localStorage.setItem("profiles", JSON.stringify(profiles)); } catch {}
  try { localStorage.setItem("me", p.id); } catch {}
  registerProfiles();
  investor = p.id;
  onboarding = false;
  draft = blankDraft();
  prevOrder = {};
  render();
}

// Onboarding as a step-by-step dialog: one question per screen, large choices, progress dots.
let step = 0;
let focusedStep = -1;
const LAST = 5;
const HINT: Record<string, [string, string]> = {
  launch_post: ["A company says it is launching or out of stealth", "公司宣布发布或结束隐身期"],
  hiring: ["A first engineering hire is posted", "发布首批工程师职位"],
  show_hn: ["The builders show it to Hacker News", "创始人在 Hacker News 展示"],
  paper: ["A paper or project page by the team", "团队发表论文或项目页"],
  left_job: ["Someone leaves a lab or company to start one", "有人离开实验室或公司创业"],
  star_velocity: ["A new repository gains stars fast", "新仓库 Star 快速增长"],
  form_d: ["An SEC filing shows money is being raised", "SEC 文件显示正在融资"],
  linkedin_post: ["A founder posts about what they are building", "创始人发帖介绍在做的事"],
  cohort: ["Listed in an accelerator or fellowship batch", "进入孵化器或 fellowship 名单"],
  proves_by_running: ["Shows results by running a test or exploit, not an opinion", "通过实际运行测试或攻击来证明，而非主观判断"],
  agent_runtime_controls: ["Controls what an AI agent is allowed to do", "管控 AI Agent 可执行的操作"],
  code_verification: ["Checks or tests code written by AI", "检查或测试 AI 写的代码"],
  open_source: ["The product is open source", "产品开源"],
  works_across_agents: ["Works with several agents, models or repos", "可用于多种 Agent、模型或代码库"],
};
const PRESETS: Record<string, { en: string; cn: string; hint: [string, string]; w: Record<string, number> }> = {
  balanced: { en: "Balanced", cn: "均衡", hint: ["Every dimension counts the same", "各维度权重相同"], w: {} },
  founder: { en: "Founder first", cn: "创始人优先", hint: ["Who they are and why them", "看人：是谁、为什么是他们"], w: { identity: 25, founder_market_fit: 30, ambition: 15, product_value: 5, gtm_traction: 5, tech_traction: 10, growth_path: 5, investor_hype: 5 } },
  traction: { en: "Evidence first", cn: "证据优先", hint: ["Working product, users and code", "看事：产品、用户与代码"], w: { identity: 5, founder_market_fit: 15, ambition: 5, product_value: 25, gtm_traction: 20, tech_traction: 25, growth_path: 2.5, investor_hype: 2.5 } },
};
function wizard() {
  const picks = (group: "sectors" | "avoid" | "signals" | "tags", items: string[]) => `<div class="picks">${items.map((x) => `<label class="pick"><input type="checkbox" data-group="${group}" value="${x}" ${draft[group].includes(x) ? "checked" : ""}${group === "avoid" && draft.sectors.includes(x) ? " disabled" : ""}><span><b>${esc(word(x))}</b>${HINT[x] ? `<small>${esc(T(HINT[x][0], HINT[x][1]))}</small>` : ""}</span></label>`).join("")}</div>`;
  const total = Object.values(draft.dims).reduce((x, y) => x + y, 0) || 1;
  const screens: [string, string, string][] = [
    [T("Let's set up your list", "先来设置您的名单"), T("This takes about a minute. The engine ranks the same companies differently for each investor, then learns from every vote.", "大约一分钟。引擎会为每位投资人对同一批公司给出不同排序，并从每次投票中学习。"),
      `<label class="fld big"><span>${T("What should we call you?", "怎么称呼您？")}</span><input id="onb-name" type="text" maxlength="40" autocomplete="off" value="${esc(draft.name)}" placeholder="${T("e.g. Robotics partner", "例如：机器人方向合伙人")}"></label>`],
    [T("Which sectors do you want more of?", "您希望多看哪些赛道？"), T("Pick any number. Companies in these sectors move up your list.", "可多选。这些赛道的公司会在您的名单中上移。"), picks("sectors", SECTORS)],
    [T("Anything you'd rather see less of?", "有希望少看的赛道吗？"), T("Optional. These move down, they are not hidden.", "可选。这些赛道会下移，但不会隐藏。"), picks("avoid", SECTORS)],
    [T("Which early signals do you trust?", "您信任哪些早期信号？"), T("A company found through these gets a small lift.", "通过这些信号发现的公司会获得小幅加分。"), picks("signals", SIGNALS)],
    [T("Any traits you look for?", "您看重哪些特征？"), T("Optional. Set only when a company's own sources state them.", "可选。仅当公司自身的公开信息明确提到时才会标注。"), picks("tags", TAGS)],
    [T("How do you weigh a company?", "您如何权衡一家公司？"), T("Start from a preset, then adjust. Anything the web cannot show stays unknown whatever its weight.", "先选一个预设，再微调。无法从公开信息验证的维度，无论权重多少都保持未知。"),
      `<div class="presets">${Object.entries(PRESETS).map(([k, v]) => `<button type="button" class="preset ${draftPreset === k ? "on" : ""}" data-preset="${k}"><b>${T(v.en, v.cn)}</b><small>${T(v.hint[0], v.hint[1])}</small></button>`).join("")}</div>
       <div class="sliders">${data.dims.map((d: any) => `<label class="sld"><span>${esc(lang === "cn" ? CN[d.key] ?? d.label : d.label)}</span><input type="range" min="0" max="30" step="2.5" data-dim="${d.key}" value="${draft.dims[d.key] ?? 12.5}"><output data-out="${d.key}" class="m">${Math.round(((draft.dims[d.key] ?? 0) / total) * 100)}%</output></label>`).join("")}</div>`],
  ];
  const [title, sub, body] = screens[step];
  const dots = screens.map((_, i) => `<i class="${i === step ? "now" : i < step ? "done" : ""}"></i>`).join("");
  return `<div class="wz-back" data-wz-close="1"></div>
  <form id="onb" class="wz" role="dialog" aria-modal="true" aria-labelledby="wz-title">
    <div class="wz-top"><div class="wz-dots" role="img" aria-label="${T(`Step ${step + 1} of ${screens.length}`, `第 ${step + 1} 步，共 ${screens.length} 步`)}">${dots}</div>${profiles.length ? `<button type="button" class="wz-x" data-onb-cancel="1" aria-label="${T("Close", "关闭")}">×</button>` : ""}</div>
    <div class="wz-body" data-step="${step}"><h2 id="wz-title">${title}</h2><p class="wz-sub">${sub}</p>${body}</div>
    <div class="wz-foot">${step > 0 ? `<button type="button" class="wz-link" data-wz-back="1">${T("Back", "上一步")}</button>` : "<span></span>"}<span class="wz-count m">${step + 1} / ${screens.length}</span><button type="submit" class="primary">${step < LAST ? T("Continue", "继续") : T("Show my list", "查看我的名单")}</button></div>
  </form>`;
}
let draftPreset = "balanced";
function renderWizard() {
  let el = document.getElementById("wizard");
  if (!el) { el = document.createElement("div"); el.id = "wizard"; document.body.appendChild(el); }
  const show = neutral() && onboarding;
  el.innerHTML = show ? wizard() : "";
  el.className = show ? "open" : "";
  document.documentElement.classList.toggle("wz-lock", show);
  if (show && focusedStep !== step) { focusedStep = step; (el.querySelector("input:not([disabled]), .preset") as HTMLElement | null)?.focus({ preventScroll: true }); }
  if (!show) focusedStep = -1;
}

function comparePanel() {
  const ids = Object.keys(PERSONAS);
  if (!investor || ids.length < 2) return neutral() ? `<div class="compare"><h3>${T("Compare investors", "投资人对比")}</h3><p class="fine">${T("Add a second investor to see how two people's lists drift apart as they vote.", "再创建一位投资人，即可看到两人的名单如何随投票逐渐分化。")}</p></div>` : "";
  const cname = new Map<string, { id: string; name: string }>(data.candidates.map((c: Candidate) => [c.id, c]));
  const label = (id: string) => esc(nameOf(cname.get(id) ?? { id, name: id }));
  const rows = ids.filter((k) => k !== investor).map((o) => {
    const series = compare(investor, o, data.candidates, data.scores, feedback.slice(-40));
    const last = series[series.length - 1];
    const tail = series.slice(-10);
    const bars = tail.map((pt) => `<i title="${pt.shared}/${pt.of}" style="height:${Math.max(6, Math.round(((pt.shared || 0) / (pt.of || 1)) * 36))}px"></i>`).join("");
    const onlyMine = last.top_a.filter((id) => !last.top_b.includes(id)).slice(0, 4).map(label).join(", ");
    const onlyTheirs = last.top_b.filter((id) => !last.top_a.includes(id)).slice(0, 4).map(label).join(", ");
    return `<div class="cmp">
      <div class="cmphead"><b>${esc(word(PERSONAS[investor].name))}</b> ${T("vs", "对比")} <b>${esc(word(PERSONAS[o].name))}</b><span class="m">${feedback.filter((f) => f.investor === o).length} ${T("votes by them", "条对方反馈")}</span></div>
      <div class="cmpbody"><div class="cmpnum"><b>${last.shared}<small> / ${last.of}</small></b><span>${T("companies in both top lists now", "家公司同时在两人榜单中")}</span></div>
      <div class="spark" role="img" aria-label="${T("Shared companies after each vote", "每次投票后的共同公司数")}: ${tail.map((pt) => pt.shared).join(", ")}">${bars}</div>
      <div class="cmpwho"><p><span class="eyebrow">${T("Only yours", "仅您的榜单")}</span> ${onlyMine || "–"}</p><p><span class="eyebrow">${T("Only theirs", "仅对方榜单")}</span> ${onlyTheirs || "–"}</p></div></div>
    </div>`;
  }).join("");
  return `<div class="compare"><h3>${T("Compare investors", "投资人对比")}</h3><p class="fine">${T("Each bar is the number of companies two investors share in their top lists after one more vote, replayed from the stored events. Falling bars mean their tastes are separating.", "每根柱表示再多一次投票后，两位投资人榜单中共同公司的数量，由已存事件回放得出。柱子变矮说明两人的偏好在分化。")}</p>${rows}</div>`;
}

function watchlistPanel() {
  const all: any[] = data.watchlist ?? [];
  if (!all.length) return "";
  const w = PERSONAS[investor]?.weights ?? {};
  const liked = Object.entries(w).filter(([k, v]) => k.startsWith("sector:") && (v as number) > 0).map(([k]) => k.slice(7));
  const pool = liked.length ? all.filter((c) => liked.includes(c.sector)) : all;
  const items = pool.sort((a, b) => (b.tags.length - a.tags.length) || String(b.first_seen ?? "").localeCompare(String(a.first_seen ?? ""))).slice(0, 36);
  if (!items.length) return "";
  const li = items.map((c) => {
    const sg = data.signals[c.signal_ids[0]];
    const nm = esc(nameOf(c));
    return `<li><b>${!blind && c.domains[0] ? `<a href="https://${esc(c.domains[0])}" target="_blank" rel="noopener">${nm}</a>` : nm}</b><span class="sector">${esc(word(c.sector))}</span>${c.tags.map((t: string) => `<span class="wtag">${esc(word(t))}</span>`).join("")}${sg && !blind ? `<a class="wsrc" href="${esc(sg.url)}" target="_blank" rel="noopener" title="${esc(sg.text)}">${esc(word(sg.signal_type))} · ${esc(host(sg.url))}</a>` : ""}</li>`;
  }).join("");
  return `<div class="watch"><h3>${T("Watchlist: one signal so far", "观察名单：目前仅一个信号")}</h3><p class="fine">${T(`${num(pool.length)} companies${liked.length ? " in this investor's sectors" : ""} were seen in one place only, so they are not scored or ranked. A second independent signal moves a company into the digest.`, `${liked.length ? "该投资人关注的赛道中，" : ""}有 ${num(pool.length)} 家公司目前只在一处出现，因此不评分、不排序。出现第二个独立信号后会进入名单。`)}</p><ul class="wl">${li}</ul></div>`;
}

function benchmarks() {
  const a = data.ablation?.live, k = data.costs, c = data.counts;
  const money = (n: number | null | undefined) => (n == null ? "–" : "$" + Number(n).toFixed(n < 1 ? 3 : 2));
  const telem = a ? `<h3 class="gap">${T("With Telem vs without Telem", "有 Telem 与无 Telem 对比")}</h3>
    <div class="tablewrap"><table><thead><tr><th></th><th class="r">${T("With Telem", "有 Telem")}</th><th class="r">${T("Without Telem", "无 Telem")}</th></tr></thead><tbody>
      <tr><td>${T("Signals", "信号")}</td><td class="m r">${num(a.with_telem.signals)}</td><td class="m r">${num(a.without_telem.signals)}</td></tr>
      <tr><td>${T("Companies", "公司")}</td><td class="m r">${num(a.with_telem.companies)}</td><td class="m r">${num(a.without_telem.companies)}</td></tr>
      <tr><td>${T("Pass the two-signal gate", "通过双信号门槛")}</td><td class="m r">${num(a.with_telem.pass_gate)}</td><td class="m r">${num(a.without_telem.pass_gate)}</td></tr>
      <tr class="total"><td>${T("Digest companies that still pass", "仍能入选的公司")}</td><td class="m r">${num(a.digest)}</td><td class="m r">${num(a.digest - a.digest_companies_that_would_fail_gate_without_telem)}</td></tr>
    </tbody></table></div>
    <p class="fine">${T(`Same stored signals, same entity resolution and gate; the right column drops every signal that came through Telem. ${num(a.companies_only_telem_found)} companies were surfaced only by Telem. Corroboration is itself a Telem search, so part of the gate gap comes from the design.`, `相同的已存信号、相同的实体归并与门槛；右列去掉所有来自 Telem 的信号。有 ${num(a.companies_only_telem_found)} 家公司只由 Telem 发现。佐证步骤本身使用 Telem 搜索，因此门槛差距部分来自设计。`)}</p>` : "";
  const runs = (k?.runs ?? []).filter((r: any) => ["ingest", "build", "backtest"].includes(r.kind)).slice(-6);
  const cyc = k?.last_search_cycle;
  const cost = k ? `<h3 class="gap">${T("Cost per run", "每次运行的成本")}</h3>
    <div class="stats small"><div><b>${money(k.total_usd)}</b><span>${T("spent in total", "累计花费")}</span></div><div><b>${money(cyc?.usd)}</b><span>${T("latest full search cycle", "最近一次完整搜索")}</span></div><div><b>${money(cyc?.usd_per_digest_company)}</b><span>${T("per digest company", "每家入选公司")}</span></div><div><b>${money(k.monitors?.usd_per_tick)}</b><span>${T("per monitor tick, average", "每次监控运行（平均）")}</span></div></div>
    <div class="tablewrap"><table><thead><tr><th>${T("Run", "运行")}</th><th class="r">${T("Minutes", "分钟")}</th><th class="r">${T("Cost", "成本")}</th><th class="r">${T("Per signal", "每条信号")}</th><th class="r">${T("Per digest company", "每家入选公司")}</th><th>${T("By tool", "按工具")}</th></tr></thead><tbody>
    ${runs.map((r: any) => `<tr><td><b>${esc(r.kind)}</b> <span class="m">${esc(String(r.started_at).slice(11, 16))}</span></td><td class="m r">${r.minutes ?? "–"}</td><td class="m r">${money(r.usd)}</td><td class="m r">${money(r.usd_per_signal)}</td><td class="m r">${money(r.usd_per_digest_company)}</td><td class="m">${Object.entries(r.by_tool ?? {}).map(([t, v]) => `${esc(word(t))} ${money(v as number)}`).join(" · ")}</td></tr>`).join("")}
    </tbody></table></div>
    <p class="fine">${T("Model and funding-data calls are metered. Monitor costs are as reported by Telem. Search and Tavily costs are list-price estimates. Model calls stop at a hard budget; bulk extraction runs on a small model and only scoring uses the large one.", "模型与融资数据调用按实际计量；Monitor 成本取自 Telem 报告；搜索与 Tavily 成本按公开价估算。模型调用设有硬性预算上限；批量抽取使用小模型，仅评分使用大模型。")}</p>` : "";
  const six: [string, string, string, string][] = [
    ["01", T("Too much information", "信息过载"), T(`${num(c.signals)} signals reduced to ${num(c.digest)} companies`, `${num(c.signals)} 条信号收敛为 ${num(c.digest)} 家公司`), T("Funnel at the top", "顶部漏斗")],
    ["02", T("Fragmented context", "上下文分散"), T("LinkedIn, X, job boards, SEC, GitHub, Hacker News and cohort pages joined into one record per company", "LinkedIn、X、招聘页、SEC、GitHub、Hacker News 与孵化器名单归并为每家公司一条记录"), T("Evidence on each company", "每家公司的证据")],
    ["03", T("Expensive", "成本高"), T("Per-run cost benchmark, hard model budget, small model for bulk work", "逐次运行成本基准、模型硬预算、批量任务用小模型"), T("Cost per run, above", "上方的运行成本")],
    ["04", T("Weak personalization", "个性化弱"), T("Each investor ranks the same companies differently and sees why", "每位投资人对同一批公司有不同排序，并能看到原因"), T("Investor tabs, why ranked here", "投资人标签页与排序原因")],
    ["05", T("Limited memory", "记忆有限"), T("Votes are stored as append-only events; preferences are recomputed from them and travel by link", "投票以只追加事件存储；偏好由事件重新计算，并可通过链接携带"), T("What the engine has learned", "引擎学到了什么")],
    ["06", T("Low performance, wrong source", "性能低、来源选错"), T("Telem auto-routing where the source is unknown, pinned providers where it is known", "来源未知时用 Telem 自动路由，来源已知时指定提供方"), T("With vs without Telem, above", "上方的 Telem 对比")],
  ];
  const problems = `<h3 class="gap">${T("Against SearchHack's six search problems", "对照 SearchHack 提出的六个搜索难题")}</h3>
    <div class="tablewrap"><table><thead><tr><th></th><th>${T("Problem", "难题")}</th><th>${T("What the engine does", "引擎的做法")}</th><th>${T("Where to see it", "在哪里看")}</th></tr></thead><tbody>
    ${six.map(([n, p, w, s]) => `<tr><td class="m">${n}</td><td><b>${p}</b></td><td>${w}</td><td>${s}</td></tr>`).join("")}</tbody></table></div>`;
  return `<div class="bench">${telem}${cost}${problems}</div>`;
}

function render() {
  const ranked = data.scores.length ? rank(investor, data.candidates, data.scores, feedback) : [];
  const before = prevOrder[investor] ?? [];
  const c = data.counts;
  document.documentElement.lang = lang === "cn" ? "zh-CN" : "en";
  document.body.className = `lang-${lang}`;
  $("#btn-en").classList.toggle("active", lang === "en");
  $("#btn-cn").classList.toggle("active", lang === "cn");

  blindIx = new Map([...data.candidates].sort((a: Candidate, b: Candidate) => a.id.localeCompare(b.id)).map((x: Candidate, i: number) => [x.id, i]));
  $("#pub").textContent = neutral() ? T("Open Sourcing Engine · built at SearchHack", "开放版 Sourcing Engine · SearchHack 作品") : T("Sourcing Engine · SearchHack showcase", "Sourcing Engine · SearchHack 展示项目");
  $("#title").textContent = T("Founders before the press release", "在新闻稿之前找到创始人");
  $("#sub").textContent = T("Telem Monitors and pinned searches collect early signals. Signals are merged per company and each company is scored only on what the web can show.", "Telem Monitors 与指定来源搜索持续收集早期信号，按公司归并后，只对网上可验证的部分评分。");
  $("#stamp").innerHTML = `${esc(new Date(data.generated_at).toISOString().slice(0, 16).replace("T", " "))} UTC<br>${data.public_demo ? T("Public demo mode", "公开演示模式") : T("Internal mode", "内部模式")}`;
  $("#thesis").innerHTML = `<p>${T("Every claim is labeled by where it comes from: F is the founder's own claim, V is a verified record, A is the agent's inference. A rubric dimension with no public evidence is marked U and left unscored. Companies are ranked by the low end of their score range.", "每条论据都标注来源：F 为创始人自述，V 为已核实记录，A 为模型推断。没有公开证据的评分维度标为 U，不予打分。公司按分数区间的下限排序。")}</p>
    <div class="legend"><span><i class="tag tF">F</i>${LABEL().F}</span><span><i class="tag tV">V</i>${LABEL().V}</span><span><i class="tag tA">A</i>${LABEL().A}</span><span><i class="tag tU">U</i>${T("Unknown, not scored", "未知，不打分")}</span></div>`;
  $("#funnel").innerHTML = [[c.signals, T("signals ingested", "条信号")], [c.candidates, T("companies after entity resolution", "家公司（实体归并后）")], [c.candidates - c.gated_out, T("pass the two-signal gate", "家通过双信号门槛")], [c.already_raised, T("moved to already raised", "家已融资，移出")], [(c.not_us ?? 0) + (c.location_unconfirmed ?? 0), T("not confirmed US-based", "家未确认在美国")], [c.digest, T("US-based, in the digest", "家美国公司进入名单")]]
    .map(([n, l], i) => `<div class="${i === 5 ? "final" : ""}"><b>${num(n as number)}</b><span>${l}</span></div>`).join("");

  $("#h-digest").textContent = T("The digest", "入选名单");
  $("#h-machine").textContent = T("How it got here", "信号从哪里来");
  $("#h-backtest").textContent = T("Blind backtest", "盲测回测");
  $("#tabs").innerHTML = Object.entries(PERSONAS).map(([k, v]) => `<button class="persona ${k === investor ? "active" : ""}" data-investor="${k}"><b>${esc(word(v.name))}</b><span>${esc(lang === "cn" ? CN[v.blurb] ?? v.blurb : v.blurb)}</span></button>`).join("") + (neutral() ? `<button class="persona add" data-new="1"><b>+ ${T("New investor", "新建投资人")}</b><span>${T("Set your own preferences", "设置自己的偏好")}</span></button>` : "");
  const n = feedback.filter((f) => f.investor === investor).length;
  const pname = PERSONAS[investor]?.name ?? T("no investor yet", "尚无投资人");
  $("#listhead").innerHTML = `<p>${T(`Ranked by the lower bound, a bonus for one standout dimension, and ${pname}'s learned fit. ${data.weights_note}.`, `按保守下界、单项突出加分与${word(pname)}的偏好修正排序。${neutral() ? "使用您自己的评分权重" : data.public_demo ? "演示用等权重" : "工作草案权重"}。`)} <span class="m">${n} ${T(n === 1 ? "feedback event" : "feedback events", "条反馈")}</span></p><span class="headbtns"><button class="link" data-blind="1" aria-pressed="${blind}">${blind ? T("Show company names", "显示公司名称") : T("Hide company names", "隐藏公司名称")}</button>${n ? `<button id="reset" class="link">${T("Reset feedback", "清空反馈")}</button>` : ""}</span>`;
  let memEl = document.getElementById("memory");
  if (!memEl) { memEl = document.createElement("div"); memEl.id = "memory"; $("#listhead").after(memEl); }
  memEl.innerHTML = memoryPanel();
  renderWizard();
  let cmpEl = document.getElementById("compare");
  if (!cmpEl) { cmpEl = document.createElement("div"); cmpEl.id = "compare"; $("#list").after(cmpEl); }
  cmpEl.innerHTML = watchlistPanel() + comparePanel();
  $("#list").innerHTML = ranked.length
    ? ranked.map((r, i) => { const was = before.indexOf(r.candidate.id); return row(r, i, was >= 0 ? was - i : 0); }).join("")
    : `<div class="empty"><b>${T("Scoring is still running.", "评分仍在进行。")}</b><span>${T(`${num(c.digest)} companies passed the gates and are waiting for a score. Reload in a minute.`, `${num(c.digest)} 家公司已通过门槛，等待评分。请稍后刷新。`)}</span></div>`;
  prevOrder[investor] = ranked.map((r) => r.candidate.id);
  $("#machine").innerHTML = machinery() + benchmarks();
  $("#backtest").innerHTML = backtest();
  $("#foot-desc").textContent = neutral() ? T("An open sourcing engine built at SearchHack on Telem and Tavily.", "基于 Telem 与 Tavily、在 SearchHack 上构建的开放版 sourcing 引擎。") : T("Built at SearchHack on Telem and Tavily.", "在 SearchHack 上基于 Telem 与 Tavily 构建。");
  $("#foot-class").textContent = neutral() ? T("Public sources only · investors are made by the people using this page", "仅使用公开来源 · 投资人画像由使用者自行创建") : data.public_demo ? T("Public sources only · demo personas", "仅使用公开来源 · 演示用投资人画像") : T("Public sources only", "仅使用公开来源");
}

window.addEventListener("hashchange", async () => { if (data) { await loadFeedback(); if (neutral()) await loadProfiles(); prevOrder = {}; render(); } });

// Onboarding form: keep the draft in memory so a re-render (language switch) does not lose it.
document.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement;
  if (!t.closest || !t.closest("#onb")) return;
  if (t.id === "onb-name") draft.name = t.value;
  else if (t.dataset.dim) {
    draft.dims[t.dataset.dim] = Number(t.value);
    const total = Object.values(draft.dims).reduce((a, b) => a + b, 0) || 1;
    for (const o of document.querySelectorAll<HTMLOutputElement>("#onb output[data-out]")) o.textContent = `${Math.round(((draft.dims[o.dataset.out!] ?? 0) / total) * 100)}%`;
  } else if (t.dataset.group) {
    const g = t.dataset.group as "sectors" | "avoid" | "signals" | "tags";
    draft[g] = t.checked ? [...new Set([...draft[g], t.value])] : draft[g].filter((x) => x !== t.value);
    if (g === "sectors" && t.checked) draft.avoid = draft.avoid.filter((x) => x !== t.value);
  }
});
document.addEventListener("submit", (e) => {
  if ((e.target as HTMLElement).id !== "onb") return;
  e.preventDefault();
  if (step < LAST) { step++; renderWizard(); }
  else { step = 0; draftPreset = "balanced"; void createProfile(); }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && onboarding && profiles.length) { onboarding = false; render(); } });
document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.dataset?.wzClose && profiles.length) { onboarding = false; render(); }
});

(window as any).setLang = (l: "en" | "cn") => { lang = l; if (data) render(); };

document.addEventListener("click", async (e) => {
  const t = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
  if (!t) return;
  if (t.dataset.investor) { investor = t.dataset.investor; pending = null; onboarding = false; try { localStorage.setItem("me", investor); } catch {} return render(); }
  if (t.dataset.new) { onboarding = true; step = 0; draftPreset = "balanced"; draft = blankDraft(); return render(); }
  if (t.dataset.wzBack) { step = Math.max(0, step - 1); return renderWizard(); }
  if (t.dataset.preset) { draftPreset = t.dataset.preset; const w = PRESETS[draftPreset].w; draft.dims = Object.fromEntries(data.dims.map((d: any) => [d.key, w[d.key] ?? 12.5])); return renderWizard(); }
  if (t.dataset.onbCancel) { onboarding = false; return render(); }
  if (t.dataset.blind) { blind = !blind; return render(); }
  if (t.dataset.toggle) { open.has(t.dataset.toggle) ? open.delete(t.dataset.toggle) : open.add(t.dataset.toggle); return render(); }
  if (t.dataset.vote) { pending = { id: t.dataset.id!, vote: Number(t.dataset.vote) as 1 | -1 }; return render(); }
  if (t.dataset.cancel) { pending = null; return render(); }
  if (t.dataset.reason && pending) { const ev = { investor, candidate_id: pending.id, vote: pending.vote, reason: t.dataset.reason }; pending = null; await sendFeedback(ev); return render(); }
  if (t.id === "reset") return resetFeedback();
  if (t.dataset.share) {
    const link = `${location.origin}${location.pathname}#m=${space}`;
    try { await navigator.clipboard.writeText(link); t.textContent = T("Link copied", "链接已复制"); } catch { prompt(T("Copy this link", "复制此链接"), link); }
    return;
  }
});

(async () => {
  try {
    data = await (await fetch("data.json")).json();
    await loadFeedback();
    if (neutral()) { draft = blankDraft(); await loadProfiles(); }
    render();
  } catch (e) {
    $("#list").innerHTML = `<div class="empty"><b>Could not load data.json.</b></div>`;
  }
})();
