// Self-contained, read-only web dashboard for one group. Served at
// /view/:token. Items are embedded as JSON and rendered client-side via
// textContent (never innerHTML) so user-supplied titles/summaries can't inject
// markup; outbound links are restricted to http(s).

export type DashItem = {
  kind: string;
  title: string;
  date: string;
  tags: string[];
  summary: string[];
  driveUrl: string;
  originalUrl: string;
  unsent: boolean;
};

export function renderDashboardHtml(params: { title: string; items: DashItem[] }): string {
  // Escape `<` so the data can't terminate the <script> block.
  const data = JSON.stringify(params.items).replace(/</g, "\\u003c");
  const title = escapeHtml(params.title);

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif; line-height: 1.6; background: #f6f7f9; color: #1a1a1a; }
  header { position: sticky; top: 0; background: #fff; border-bottom: 1px solid #e3e6ea; padding: 12px 16px; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  .count { color: #6b7280; font-size: 13px; font-weight: normal; }
  .controls { display: flex; gap: 8px; flex-wrap: wrap; }
  input[type=search] { flex: 1 1 220px; min-width: 0; padding: 8px 10px; border: 1px solid #cbd2d9; border-radius: 8px; font-size: 15px; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip { padding: 6px 10px; border: 1px solid #cbd2d9; border-radius: 999px; background: #fff; font-size: 13px; cursor: pointer; }
  .chip.active { background: #2563eb; color: #fff; border-color: #2563eb; }
  main { padding: 12px 16px 48px; max-width: 860px; margin: 0 auto; }
  .card { background: #fff; border: 1px solid #e3e6ea; border-radius: 12px; padding: 14px 16px; margin-bottom: 12px; }
  .card.unsent { opacity: .55; }
  .card h2 { font-size: 16px; margin: 0 0 4px; }
  .card h2 .strike { text-decoration: line-through; }
  .meta { font-size: 12px; color: #6b7280; margin-bottom: 8px; }
  .tags { display: flex; gap: 6px; flex-wrap: wrap; margin: 6px 0; }
  .tag { font-size: 12px; color: #2563eb; cursor: pointer; }
  ul { margin: 6px 0 0; padding-left: 1.2em; }
  li { font-size: 14px; }
  .links a { font-size: 13px; margin-right: 12px; }
  .badge { display: inline-block; font-size: 11px; background: #9ca3af; color: #fff; border-radius: 4px; padding: 1px 6px; margin-left: 6px; vertical-align: middle; }
  .empty { color: #6b7280; text-align: center; padding: 40px 0; }
</style>
</head>
<body>
<header>
  <h1>${title} <span class="count" id="count"></span></h1>
  <div class="controls">
    <input type="search" id="q" placeholder="タイトル・要約・タグで検索" autocomplete="off" />
    <div class="chips" id="kinds">
      <span class="chip active" data-kind="">すべて</span>
      <span class="chip" data-kind="pdf">📄 PDF</span>
      <span class="chip" data-kind="url">🔗 URL</span>
      <span class="chip" data-kind="file">📎 ファイル</span>
    </div>
  </div>
</header>
<main id="list"></main>
<script>
const ITEMS = ${data};
const ICON = { pdf: "📄", url: "🔗", file: "📎" };
let q = "", kind = "";

function safeUrl(u) { return typeof u === "string" && /^https?:\\/\\//i.test(u) ? u : ""; }

function matches(it) {
  if (kind && it.kind !== kind) return false;
  if (!q) return true;
  const hay = (it.title + " " + (it.summary||[]).join(" ") + " " + (it.tags||[]).join(" ")).toLowerCase();
  return hay.includes(q);
}

function render() {
  const list = document.getElementById("list");
  list.textContent = "";
  const shown = ITEMS.filter(matches);
  document.getElementById("count").textContent = "(" + shown.length + "件)";
  if (!shown.length) {
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = "該当する資料がありません。";
    list.appendChild(d);
    return;
  }
  for (const it of shown) {
    const card = document.createElement("div");
    card.className = "card" + (it.unsent ? " unsent" : "");

    const h = document.createElement("h2");
    const t = document.createElement("span");
    t.textContent = (ICON[it.kind] || "•") + " " + it.title;
    if (it.unsent) t.className = "strike";
    h.appendChild(t);
    if (it.unsent) {
      const b = document.createElement("span");
      b.className = "badge"; b.textContent = "送信取消済み";
      h.appendChild(b);
    }
    card.appendChild(h);

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = it.date || "";
    card.appendChild(meta);

    if ((it.tags||[]).length) {
      const tags = document.createElement("div");
      tags.className = "tags";
      for (const tag of it.tags) {
        const s = document.createElement("span");
        s.className = "tag"; s.textContent = "#" + tag.replace(/^#/, "");
        s.onclick = () => { const el = document.getElementById("q"); el.value = tag.replace(/^#/, ""); q = el.value.toLowerCase(); render(); };
        tags.appendChild(s);
      }
      card.appendChild(tags);
    }

    if ((it.summary||[]).length) {
      const ul = document.createElement("ul");
      for (const line of it.summary) {
        const li = document.createElement("li");
        li.textContent = line;
        ul.appendChild(li);
      }
      card.appendChild(ul);
    }

    const links = document.createElement("div");
    links.className = "links";
    const drive = safeUrl(it.driveUrl);
    if (drive) { const a = document.createElement("a"); a.href = drive; a.target = "_blank"; a.rel = "noopener"; a.textContent = "📁 保存先"; links.appendChild(a); }
    const orig = safeUrl(it.originalUrl);
    if (orig) { const a = document.createElement("a"); a.href = orig; a.target = "_blank"; a.rel = "noopener"; a.textContent = "🔗 元URL"; links.appendChild(a); }
    card.appendChild(links);

    list.appendChild(card);
  }
}

document.getElementById("q").addEventListener("input", (e) => { q = e.target.value.trim().toLowerCase(); render(); });
document.getElementById("kinds").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip"); if (!chip) return;
  kind = chip.getAttribute("data-kind") || "";
  for (const c of document.querySelectorAll(".chip")) c.classList.toggle("active", c === chip);
  render();
});
render();
</script>
</body>
</html>`;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
