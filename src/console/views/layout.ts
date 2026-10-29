import { esc } from "./shared.js";

/**
 * The console's frame (#63): style, top bar and the small script behind tabs, threads and live
 * updates. Server-rendered HTML that reads on a phone; the script only adds to it, so every page
 * still works without it.
 */

const STYLE = `
:root {
  --bg: #f6f5f1; --fg: #1c1b19; --muted: #706e67; --line: #e7e4dc; --card: #fff; --soft: #f0eee8;
  --accent: #2f6f4f; --accent-fg: #fff; --warn: #b4441c; --warn-soft: #fbeae3; --chip: #eef2ee;
  --me: #0a84ff; --me-fg: #fff; --them: #e9e9eb; --them-fg: #1c1b19;
  --done: #2f9e5b; --half: #8cc9a1; --miss: #d9534f; --open: #c9c6bd;
  --shadow: 0 1px 2px rgba(0,0,0,.04), 0 4px 16px rgba(0,0,0,.04);
  --serif: "New York", "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
}
@media (prefers-color-scheme: dark) { :root {
  --bg: #121211; --fg: #ecebe6; --muted: #9d9b94; --line: #2c2b28; --card: #1b1b19; --soft: #23221f;
  --accent: #7cc59d; --accent-fg: #10231a; --warn: #f0926a; --warn-soft: #3a231a; --chip: #23302a;
  --me: #0a84ff; --me-fg: #fff; --them: #2c2c2e; --them-fg: #ecebe6;
  --done: #4cc27e; --half: #2f6f4f; --miss: #e0716d; --open: #4a4842;
  --shadow: none;
} }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 920px; margin: 0 auto; padding: 16px 16px 48px; }
a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
h1, h2, h3 { font-family: var(--serif); font-weight: 600; letter-spacing: -.01em; }
h1 { font-size: 28px; margin: 0; line-height: 1.15; } h2 { font-size: 20px; margin: 28px 0 10px; } h3 { font-size: 16px; margin: 14px 0 6px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 14px 16px; margin: 10px 0; overflow-wrap: anywhere; box-shadow: var(--shadow); }
.muted { color: var(--muted); font-size: 13px; } .warn { color: var(--warn); }
.chip { display: inline-block; background: var(--chip); border-radius: 999px; padding: 2px 10px; font-size: 12px; line-height: 1.6; white-space: nowrap; }
.chip.warn { background: var(--warn-soft); color: var(--warn); }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; } .spread { justify-content: space-between; }
nav.top { position: sticky; top: 0; z-index: 5; display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 10px 16px; background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(10px); border-bottom: 1px solid var(--line); }
nav.top .brand { font-family: var(--serif); font-weight: 600; font-size: 18px; color: var(--fg); }
input, select, textarea, button { font: inherit; color: inherit; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 7px 12px; max-width: 100%; }
textarea { width: 100%; min-height: 44px; resize: vertical; } button { cursor: pointer; } button:hover { border-color: var(--muted); }
button.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); font-weight: 600; }
button.small { padding: 3px 10px; font-size: 13px; }
form.inline { display: inline; } details > summary { cursor: pointer; } details > summary::marker { color: var(--muted); }
pre { white-space: pre-wrap; margin: 0; font: 13px/1.5 ui-monospace, Menlo, monospace; }
table { border-collapse: collapse; width: 100%; } td, th { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; } th { font-size: 13px; color: var(--muted); font-weight: 500; }
.avatar { flex: none; width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; background: var(--chip); color: var(--accent); font-family: var(--serif); font-weight: 600; font-size: 17px; }
.avatar.big { width: 56px; height: 56px; font-size: 21px; }
.badge { display: inline-grid; place-items: center; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px; background: var(--warn); color: #fff; font-size: 12px; font-weight: 700; }
.stats { display: flex; gap: 22px; flex-wrap: wrap; margin-top: 12px; }
.stat b { display: block; font-family: var(--serif); font-size: 26px; line-height: 1.1; } .stat span { font-size: 12px; color: var(--muted); }
.tabs { position: sticky; top: 49px; z-index: 4; display: flex; gap: 4px; padding: 4px; margin: 14px 0 6px; background: var(--soft); border-radius: 12px; overflow-x: auto; }
.tabs a { flex: 1; text-align: center; padding: 7px 10px; border-radius: 9px; color: var(--muted); font-weight: 500; white-space: nowrap; }
.tabs a.on { background: var(--card); color: var(--fg); box-shadow: var(--shadow); }
.tabs a:hover { text-decoration: none; color: var(--fg); }
a.tester { display: block; color: inherit; } a.tester:hover { text-decoration: none; } a.tester .card:hover { border-color: var(--muted); }
.preview { color: var(--muted); font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.scroller { height: min(68vh, 660px); overflow-y: auto; overscroll-behavior: contain; background: var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 10px 12px; }
.start { text-align: center; margin: 6px 0 10px; }
.msg { display: flex; flex-direction: column; margin: 3px 0; }
.msg.me { align-items: flex-end; } .msg.them { align-items: flex-start; }
.bubble { max-width: min(78%, 520px); padding: 8px 13px; border-radius: 19px; white-space: pre-wrap; overflow-wrap: anywhere; }
.msg.me .bubble { background: var(--me); color: var(--me-fg); border-bottom-right-radius: 6px; }
.msg.them .bubble { background: var(--them); color: var(--them-fg); border-bottom-left-radius: 6px; }
.msg .meta { font-size: 11px; color: var(--muted); margin: 2px 8px 4px; }
.msg.me .bubble a { color: inherit; text-decoration: underline; }
.divider { text-align: center; font-size: 12px; color: var(--muted); margin: 14px 0 6px; font-weight: 600; }
.event { margin: 8px auto; max-width: 560px; background: var(--soft); border: 1px solid var(--line); border-radius: 14px; padding: 10px 12px; font-size: 14px; overflow-wrap: anywhere; }
.event.app { background: none; border: none; text-align: center; color: var(--muted); font-size: 12px; padding: 2px; }
.event .head { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-bottom: 4px; }
.idea { border-left: 4px solid var(--accent); } .idea.waiting { border-left-color: var(--warn); }
.typing { color: var(--muted); font-size: 13px; margin: 6px 4px; min-height: 1em; }
.composer { display: flex; gap: 8px; align-items: flex-end; margin-top: 10px; }
.composer textarea { border-radius: 20px; padding: 9px 14px; }
.composer button { border-radius: 20px; }
.options { margin: 6px 4px 0; font-size: 13px; color: var(--muted); }
img.proof { max-width: 220px; max-height: 220px; border-radius: 14px; display: block; }
.empty { text-align: center; color: var(--muted); padding: 28px 12px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
`;

/**
 * Tabs remember themselves per device; threads open at the newest message, load older ones on
 * scroll-up, and take new ones every few seconds while the page is visible. Nothing is replaced
 * while a founder is typing or has a form open in it.
 */
const SCRIPT = `(function () {
  var root = document.querySelector("[data-tester]");
  if (!root) return;
  var base = "/console/testers/" + root.dataset.tester, tab = root.dataset.tab;
  try {
    var saved = localStorage.getItem("zoh-tab");
    if (!new URLSearchParams(location.search).get("tab") && saved && saved !== tab && root.dataset.tabs.split(",").indexOf(saved) >= 0) {
      location.replace(base + "?tab=" + saved + location.hash);
      return;
    }
    localStorage.setItem("zoh-tab", tab);
  } catch (e) {}
  var boxes = Array.prototype.slice.call(document.querySelectorAll(".scroller"));
  function tidy(box) {
    var ids = {};
    box.querySelectorAll("[data-id]").forEach(function (el) { if (ids[el.dataset.id]) el.remove(); else ids[el.dataset.id] = 1; });
    var day = null;
    box.querySelectorAll(".divider").forEach(function (d) { if (d.dataset.day === day) d.remove(); else day = d.dataset.day; });
  }
  function json(url) { return fetch(url, { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; }); }
  boxes.forEach(function (box) {
    var items = box.querySelector(".items");
    box.scrollTop = box.scrollHeight;
    window.addEventListener("load", function () { box.scrollTop = box.scrollHeight; });
    box.addEventListener("scroll", function () {
      if (box.scrollTop > 120 || box.dataset.loading || !box.dataset.before) return;
      box.dataset.loading = "1";
      json(base + "/" + box.dataset.kind + "?before=" + box.dataset.before).then(function (j) {
        if (!j) return;
        var h = box.scrollHeight;
        items.insertAdjacentHTML("afterbegin", j.html);
        tidy(box);
        box.scrollTop += box.scrollHeight - h;
        if (j.before) box.dataset.before = j.before;
        else { delete box.dataset.before; var s = box.querySelector(".start"); if (s) s.textContent = "The beginning"; }
      }).catch(function () {}).then(function () { delete box.dataset.loading; });
    });
  });
  if (!boxes.length) return;
  function poll() {
    if (document.hidden) return;
    var q = boxes.map(function (b) { return b.dataset.kind + "=" + b.dataset.after; });
    json(base + "/updates?" + q.join("&")).then(function (j) {
      if (!j) return;
      boxes.forEach(function (box) {
        var u = j[box.dataset.kind];
        if (!u) return;
        box.dataset.after = u.after;
        if (!u.html) return;
        var near = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
        box.querySelector(".items").insertAdjacentHTML("beforeend", u.html);
        tidy(box);
        if (near) box.scrollTop = box.scrollHeight;
      });
      var t = document.getElementById("thinking");
      if (t && "thinking" in j) t.textContent = j.thinking;
      var side = document.getElementById("side");
      if (side && j.side && side.dataset.sig !== j.side.sig && !side.contains(document.activeElement) && !side.querySelector("details[open]")) side.outerHTML = j.side.html;
    }).catch(function () {});
  }
  setInterval(poll, 4000);
})();`;

export function layout(title: string, body: string, opts: { name?: string } = {}): string {
  const top = opts.name
    ? `<nav class="top"><a class="brand" href="/console">ZOH</a><div class="row"><a href="/console/metrics">Metrics</a><span class="muted">${esc(opts.name)}</span><form class="inline" method="post" action="/console/logout"><button class="small">Log out</button></form></div></nav>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<meta name="apple-mobile-web-app-title" content="ZOH Console"><meta name="apple-mobile-web-app-capable" content="yes">
<link rel="manifest" href="/console/manifest.webmanifest"><link rel="icon" href="/console/icon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/console/icon.png">
<style>${STYLE}</style></head>
<body>${top}<main>${body}</main><script>${SCRIPT}</script></body></html>`;
}

export function loginPage(error?: string): string {
  return layout(
    "ZOH console",
    `<h1 style="margin-top:12vh">ZOH console</h1>
<form method="post" action="/console/login" class="card" style="max-width:380px">
<label>Password<br><input type="password" name="password" autocomplete="current-password" autofocus required style="width:100%;margin-top:6px"></label>
<p><button class="primary">Log in</button></p>${error ? `<p class="warn">${esc(error)}</p>` : ""}</form>`,
  );
}

export function namePage(names: string[]): string {
  const buttons = names.map((n) => `<button class="primary" name="name" value="${esc(n)}">${esc(n)}</button>`).join(" ");
  return layout("Who's this?", `<h1 style="margin-top:12vh">Who's this?</h1><p class="muted">Picked once on this device; your decisions are saved with your name.</p><form method="post" action="/console/name" class="card row" style="max-width:380px">${buttons}</form>`);
}

export function notConfiguredPage(): string {
  return layout("ZOH console", `<h1>ZOH console</h1><p>The console isn't set up yet: set CONSOLE_PASSWORD and CONSOLE_SESSION_SECRET.</p>`);
}

export const MANIFEST = JSON.stringify({
  name: "ZOH Console",
  short_name: "ZOH",
  start_url: "/console",
  scope: "/console",
  display: "standalone",
  background_color: "#f6f5f1",
  theme_color: "#2f6f4f",
  icons: [
    { src: "/console/icon.png", sizes: "180x180", type: "image/png" },
    { src: "/console/icon.svg", sizes: "any", type: "image/svg+xml" },
  ],
});

export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180"><rect width="180" height="180" rx="40" fill="#2f6f4f"/><text x="90" y="118" font-family="Helvetica, Arial, sans-serif" font-size="78" font-weight="700" fill="#fafaf8" text-anchor="middle">ZOH</text></svg>`;
