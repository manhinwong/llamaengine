import type { RawItem } from "./edgar.ts";

// Show HN / Launch HN via Algolia. Self-dated by created_at.
export async function showHN(fromTs: number, toTs: number, minPoints = 30, pages = 3): Promise<RawItem[]> {
  const out: RawItem[] = [];
  for (const q of ["Show HN", "Launch HN"]) {
    for (let page = 0; page < pages; page++) {
      const nf = encodeURIComponent(`created_at_i>${Math.floor(fromTs / 1000)},created_at_i<${Math.floor(toTs / 1000)},points>${minPoints}`);
      const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(`"${q}"`)}&tags=story&numericFilters=${nf}&hitsPerPage=100&page=${page}`;
      const res = await fetch(url);
      if (!res.ok) break;
      const j = await res.json();
      for (const h of j.hits ?? []) {
        if (!/^(Show|Launch) HN/i.test(h.title ?? "")) continue;
        out.push({
          source: "hn",
          signal_type: "show_hn",
          url: `https://news.ycombinator.com/item?id=${h.objectID}`,
          title: h.title,
          text: `${h.title} | link=${h.url ?? ""} | by=${h.author} | points=${h.points} | ${(h.story_text ?? "").replace(/<[^>]+>/g, " ").slice(0, 600)}`,
          date: h.created_at,
          label: "F",
          hint: { homepage: h.url },
        });
      }
      if ((j.hits ?? []).length < 100) break;
    }
  }
  return out;
}
