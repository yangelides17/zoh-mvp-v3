import { describe, expect, it } from "vitest";
import { addSeen, allowance, linkKey, linksIn, unseenLinks, withoutLinks, youtubeId } from "../src/coach/links.js";

describe("links in a text (#162)", () => {
  it("finds links with a scheme, www. ones and bare domains with a path, without trailing punctuation", () => {
    expect(linksIn("Try https://example.com/guide. Or www.site.org/a, or blog.co/post!")).toEqual(["https://example.com/guide", "www.site.org/a", "blog.co/post"]);
  });

  it("doesn't take a version or a file name for a link", () => {
    expect(linksIn("I use Node.js and read e.g. notes.txt")).toEqual([]);
  });

  it("keeps a bracket that belongs to the link", () => {
    expect(linksIn("(see https://en.wikipedia.org/wiki/Heat_(film))")).toEqual(["https://en.wikipedia.org/wiki/Heat_(film)"]);
  });
});

describe("matching links loosely", () => {
  it("treats every shape of a YouTube link as the same video", () => {
    expect(youtubeId("https://youtu.be/abc123?si=xyz")).toBe("abc123");
    expect(linkKey("https://www.youtube.com/watch?v=abc123&t=90s")).toBe("youtube:abc123");
    expect(linkKey("m.youtube.com/shorts/abc123")).toBe("youtube:abc123");
    expect(youtubeId("https://example.com/watch?v=abc123")).toBeUndefined();
  });

  it("ignores tracking tags, www, the scheme and a trailing slash", () => {
    expect(linkKey("https://www.Example.com/guide/?utm_source=x&page=2")).toBe(linkKey("example.com/guide?page=2"));
    expect(linkKey("https://example.com/guide?page=2")).not.toBe(linkKey("https://example.com/guide?page=3"));
  });
});

describe("the link guard", () => {
  it("allows a link it saw and flags one it didn't", () => {
    const allowed = allowance();
    addSeen(allowed, "results: https://hbr.org/2020/01/cold-calls");
    expect(unseenLinks("Read hbr.org/2020/01/cold-calls/ and https://made.up/page", allowed)).toEqual(["https://made.up/page"]);
  });

  it("flags a YouTube link it saw but didn't watch this turn", () => {
    const allowed = allowance();
    addSeen(allowed, "https://youtu.be/abc123");
    expect(unseenLinks("Watch https://www.youtube.com/watch?v=abc123", allowed)).toHaveLength(1);
    allowed.watched.add("youtube:abc123");
    expect(unseenLinks("Watch https://www.youtube.com/watch?v=abc123", allowed)).toEqual([]);
  });

  it("removes a link cleanly, keeping a markdown link's words", () => {
    expect(withoutLinks("Here's one: https://made.up/page. Want to try it?", ["https://made.up/page"])).toBe("Here's one. Want to try it?");
    expect(withoutLinks("See [this guide](https://made.up/x) today", ["https://made.up/x"])).toBe("See this guide today");
    expect(withoutLinks("Found one:\nhttps://made.up/x\n\nTry it", ["https://made.up/x"])).toBe("Found one:\n\nTry it");
  });
});
