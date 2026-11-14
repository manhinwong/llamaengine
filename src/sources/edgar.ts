// SEC EDGAR full-text search over Form D. Self-dated by file_date. Free.
const UA = "sourcing-engine-research/0.1";
const TERMS = ["robotics", "\"artificial intelligence\"", "autonomous", "\"machine learning\"", "humanoid", "\"AI\""];

export type RawItem = { source: string; signal_type: string; url: string; title: string; text: string; date: string | null; label: "F" | "V" | "A"; hint?: Record<string, unknown> };

export async function edgarFormD(startdt: string, enddt: string): Promise<RawItem[]> {
  const out = new Map<string, RawItem>();
  for (const q of TERMS) {
    for (let from = 0; from < 200; from += 100) {
      const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(q)}&forms=D&dateRange=custom&startdt=${startdt}&enddt=${enddt}&from=${from}`;
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) break;
      const hits = (await res.json()).hits?.hits ?? [];
      for (const h of hits) {
        const s = h._source;
        if (s.form !== "D") continue; // skip D/A amendments: not a first filing
        const name = String(s.display_names?.[0] ?? "").replace(/\s*\(CIK.*$/, "").trim();
        const cik = String(s.ciks?.[0] ?? "").replace(/^0+/, "");
        const adsh = String(s.adsh).replace(/-/g, "");
        const link = `https://www.sec.gov/Archives/edgar/data/${cik}/${adsh}/primary_doc.xml`;
        out.set(s.adsh, {
          source: "edgar_formd",
          signal_type: "form_d",
          url: link,
          title: `Form D: ${name}`,
          text: `${name} filed Form D on ${s.file_date}. Location: ${(s.biz_locations ?? []).join("; ")}. Incorporated: ${(s.inc_states ?? []).join(",")}. Exemption items: ${(s.items ?? []).join(",")}.`,
          date: s.file_date,
          label: "V",
          hint: { company: name },
        });
      }
      if (hits.length < 100) break;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  return [...out.values()];
}
