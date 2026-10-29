import type { MemoryTab } from "../data.js";
import { esc } from "./shared.js";

/** The Memory tab: each memory page, as the coach reads it. */
export function memoryTabHtml(tab: MemoryTab): string {
  const pages = tab.pages
    .map(({ page: p, text }) => `<details class="card"><summary><strong>${esc(p.title)}</strong> <span class="muted">${esc(p.kind)}</span></summary><pre style="margin-top:8px">${esc(text)}</pre></details>`)
    .join("");
  return `<h2 id="memory">Memory</h2>${pages || `<p class="empty">Nothing in memory yet.</p>`}`;
}
