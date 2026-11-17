/**
 * #162: the links in a text, and the guard that keeps every link ZOH sends to one it actually saw this turn
 * (their texts, its own earlier texts, the team's requests, a search result or a page it opened). Matching is
 * loose: youtu.be and youtube.com are the same video, tracking tags and trailing punctuation don't count.
 */

/** A link with a scheme, a www. one, or a bare domain with a path ("example.com/guide"; "Node.js" isn't one). */
const LINK = /\bhttps?:\/\/[^\s<>"'`]+|\bwww\.[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s<>"'`]*|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/[^\s<>"'`]*/gi;
/** Punctuation that ends a sentence rather than the link. */
const TRAILING = /[.,;:!?)\]}'"’”…*_]$/;
/** Query tags that only track where a click came from. */
const TRACKING = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|si|feature|ref|ref_src|igshid)$/i;

/** Every link in a text, as written (trailing punctuation dropped). */
export function linksIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(LINK)) {
    let link = m[0];
    // A closing bracket belongs to the link only when it opened one inside it (Wikipedia's "(film)").
    for (;;) {
      const unbalanced = link.endsWith(")") && (link.match(/\(/g)?.length ?? 0) < (link.match(/\)/g)?.length ?? 0);
      if (unbalanced || (!link.endsWith(")") && TRAILING.test(link))) link = link.slice(0, -1);
      else break;
    }
    if (link) out.push(link);
  }
  return out;
}

/** A YouTube video's id, for any of its link shapes; undefined for anything else. */
export function youtubeId(link: string): string | undefined {
  const url = parse(link);
  if (!url) return undefined;
  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, "");
  if (host === "youtu.be") return url.pathname.split("/")[1] || undefined;
  if (host !== "youtube.com" && host !== "youtube-nocookie.com") return undefined;
  if (url.pathname === "/watch") return url.searchParams.get("v") ?? undefined;
  const [, kind, id] = url.pathname.split("/");
  return kind && ["shorts", "embed", "live", "v"].includes(kind) && id ? id : undefined;
}

/** The form two links are compared in: same page, same key. */
export function linkKey(link: string): string {
  const video = youtubeId(link);
  if (video) return `youtube:${video}`;
  const url = parse(link);
  if (!url) return link.toLowerCase();
  const params = [...url.searchParams].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.hostname.replace(/^www\./, "").toLowerCase()}${path}${query}`;
}

/** The links ZOH may send this turn, by key. YouTube links also need a watch this turn (`watched`). */
export interface LinkAllowance {
  seen: Set<string>;
  watched: Set<string>;
}

export function allowance(): LinkAllowance {
  return { seen: new Set(), watched: new Set() };
}

/** Adds every link in these texts (or these links) to what ZOH has seen. */
export function addSeen(allowed: LinkAllowance, ...texts: string[]): void {
  for (const t of texts) for (const link of linksIn(t)) allowed.seen.add(linkKey(link));
}

/** The links in a reply it may not send: never seen this turn, or a video it didn't watch this turn. */
export function unseenLinks(text: string, allowed: LinkAllowance): string[] {
  return linksIn(text).filter((link) => {
    const key = linkKey(link);
    return !allowed.seen.has(key) || (key.startsWith("youtube:") && !allowed.watched.has(key));
  });
}

/** The text without these links; a line left empty goes, and a markdown link keeps its words. */
export function withoutLinks(text: string, links: string[]): string {
  let out = text;
  for (const link of links) {
    const escaped = link.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // [words](link) keeps its words; a bare link goes with the space before it.
    out = out.replace(new RegExp(`\\[([^\\]]*)\\]\\(${escaped}\\)`, "g"), "$1").replace(new RegExp(`[ \\t]*[(<]?${escaped}[)>]?`, "g"), "");
  }
  return out
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, "").replace(/[ \t]+([.,!?])/g, "$1").replace(/[:;,]([.!?])/g, "$1"))
    .filter((l, i, all) => l.trim() !== "" || (i > 0 && all[i - 1]!.trim() !== ""))
    .join("\n")
    .replace(/:\s*$/, "")
    .trim();
}

function parse(link: string): URL | undefined {
  try {
    return new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`);
  } catch {
    return undefined;
  }
}
