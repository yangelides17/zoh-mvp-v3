import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import sharp from "sharp";
import type { ConsoleConfig } from "../config.js";
import { markAlertSeen } from "../console/alerts.js";
import { clearedSessionCookie, decodeSession, encodeSession, newSession, parseCookies, passwordMatches, SESSION_COOKIE, sessionCookie, type Session } from "../console/auth.js";
import {
  CHUNK,
  consoleTab,
  mediaMessage,
  progressTab,
  recentLines,
  sideSection,
  testerHeader,
  testerRows,
  textsChunk,
  threadChunk,
  waitingAlerts,
  liveItems,
  waitingSuggestionIds,
  type SideSection,
} from "../console/data.js";
import { decideSuggestion, SuggestionError, type Decision, type SuggestionKind } from "../console/suggestions.js";
import { metricsPage } from "../console/metrics.js";
import { listPage } from "../console/views/home.js";
import { ICON_SVG, loginPage, MANIFEST, namePage, notConfiguredPage, withStagingBanner } from "../console/views/layout.js";
import { memoryCards, memoryPageView } from "../console/memory-view.js";
import { memoryPageHtml, memoryTabHtml } from "../console/views/memory.js";
import { metricsView } from "../console/views/metrics.js";
import { progressTabHtml } from "../console/views/progress.js";
import { asTab, testerView, type Tab } from "../console/views/tester.js";
import { coachThinking, consoleTabHtml, itemHtml, newest, sideHtml, textItemsHtml, textsTabHtml, thinkingLabel, threadItemsHtml, type ThreadContext } from "../console/views/threads.js";
import { confirmDraft, postFounderMessage, type ConsoleCoach } from "../console/chat.js";
import { cancelDraft } from "../console/drafts.js";
import { owns, PRODUCTION_ONLY, routeOf, type BuildInfo, type Routing } from "../testers/env.js";
import { addThreadLine, cancelRequest, COACH_AUTHOR } from "../console/requests.js";
import type { Db } from "../db/client.js";
import { consoleMessages, SUGGESTION_KINDS, testers, type Tester } from "../db/schema.js";
import { testerNow } from "../testers/clock.js";
import { safeError } from "../errors.js";
import type { MediaStore } from "../media/storage.js";
import type { TaskQueue } from "../pipeline/task-queue.js";

/**
 * The founder console (spec: GitHub issue "Founder console"): read every tester and decide on next
 * steps. Without a valid session cookie every page shows the login and every action or media link
 * answers 401; only the home-screen manifest and icon are public.
 */

export interface ConsoleRouteOptions extends ConsoleConfig {
  db: Db;
  media?: MediaStore;
  /** The console chat's coach; without it, the chat says it isn't set up. */
  chat?: ConsoleCoach;
  /** Where the coach's answer runs, after the page has redirected; without one, before. */
  queue?: TaskQueue;
  /** Staging and production (#82): the staging console says so on every page, and texts only numbers it owns. */
  routing?: Routing;
  build?: BuildInfo;
  now?: () => Date;
}

/** Longest message the chat box takes. */
export const MAX_CHAT_CHARS = 2000;
/** Most new items one live update carries; the rest come on the next. */
const LIVE_MAX = 200;
/** Most live chat cards one update re-checks (#105). */
const LIVE_CARDS = 100;

type Form = Record<string, string | undefined>;
type Params = { id: string; sid: string; aid: string; mid: string; rid: string; pid: string; did: string };

export async function consoleRoutes(app: FastifyInstance, opts: ConsoleRouteOptions): Promise<void> {
  const clock = opts.now ?? (() => new Date());
  const configured = Boolean(opts.password && opts.sessionSecret);
  const names = opts.names.length ? opts.names : ["Founder"];

  // Plain HTML forms; scoped to this plugin.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  const routing = opts.routing ?? PRODUCTION_ONLY;
  const html = (reply: FastifyReply, page: string, code = 200) =>
    reply
      .code(code)
      .header("cache-control", "no-store")
      .header("x-robots-tag", "noindex")
      .type("text/html; charset=utf-8")
      .send(routing.appEnv === "staging" ? withStagingBanner(page, opts.build) : page);

  const sessionOf = (request: FastifyRequest): Session | undefined =>
    configured ? decodeSession(parseCookies(request.headers.cookie)[SESSION_COOKIE], opts.sessionSecret!, clock()) : undefined;

  /** A page: the login (401) without a session, the name picker until a name is chosen. */
  const page = (handler: (request: FastifyRequest<{ Params: Params }>, reply: FastifyReply, name: string) => Promise<unknown>) =>
    async (request: FastifyRequest<{ Params: Params }>, reply: FastifyReply) => {
      if (!configured) return html(reply, notConfiguredPage(), 503);
      const session = sessionOf(request);
      if (!session) return html(reply, loginPage(), 401);
      if (!session.name || !names.includes(session.name)) return html(reply, namePage(names));
      return handler(request, reply, session.name);
    };

  /** An action or a file: 401 without a full session. */
  const action = (handler: (request: FastifyRequest<{ Params: Params; Body: Form }>, reply: FastifyReply, name: string) => Promise<unknown>) =>
    async (request: FastifyRequest<{ Params: Params; Body: Form }>, reply: FastifyReply) => {
      if (!configured) return reply.code(503).send({ error: "console not configured" });
      const session = sessionOf(request);
      if (!session?.name || !names.includes(session.name)) return reply.code(401).send({ error: "unauthorized" });
      return handler(request, reply, session.name);
    };

  /** A tester's own clock (#14: a dev account's may have jumped ahead); real time for an unknown id. */
  const nowFor = async (testerId: string): Promise<Date> => {
    const [row] = await opts.db.select({ clockOffsetMs: testers.clockOffsetMs }).from(testers).where(eq(testers.id, testerId));
    return row ? testerNow(row, clock()) : clock();
  };

  const back = (reply: FastifyReply, testerId: string, hash: string) => reply.redirect(`/console/testers/${encodeURIComponent(testerId)}?tab=console#${hash}`, 303);

  /** Alerts and pending next steps, signed so the page swaps them only when they change. */
  const side = (data: SideSection, ctx: ThreadContext) => {
    const unsigned = sideHtml(data, ctx, "");
    const sig = createHash("sha256").update(unsigned).digest("hex").slice(0, 16);
    return { sig, html: unsigned.replace('data-sig=""', `data-sig="${sig}"`) };
  };

  /** A founder's line in the console chat, answered by the console coach in the background (spec 4). */
  const chatLine = async (request: FastifyRequest, reply: FastifyReply, tester: Tester, name: string, body: string) => {
    const id = tester.id;
    const now = testerNow(tester, clock());
    const { needsAnswer } = await postFounderMessage(opts.db, {
      tester,
      founder: name,
      body,
      now,
      elsewhere: owns(routing, tester.phone, tester.route) ? undefined : routeOf(routing, tester.phone, tester.route),
    });
    if (needsAnswer) {
      const answer = async () => {
        try {
          if (!opts.chat) throw new Error("The console coach isn't set up (no Claude key).");
          await opts.chat.answer(id, await nowFor(id));
        } catch (err) {
          request.log.error({ err: safeError(err) }, "Console coach failed");
          const why = err instanceof Error && err.message.startsWith("The console coach") ? err.message : "Sorry, I couldn't answer that just now. Try again?";
          // ZOH's line, so it counts as the answer and the page stops waiting.
          await addThreadLine(opts.db, { testerId: id, kind: "coach", author: COACH_AUTHOR, body: why, at: await nowFor(id) });
        }
      };
      if (opts.queue) opts.queue.run(answer);
      else await answer();
    }
    return back(reply, id, "chat");
  };

  const query = (request: FastifyRequest) => request.query as Record<string, unknown>;

  app.get("/console", page(async (_request, reply, name) => {
    const now = clock();
    return html(reply, listPage(await testerRows(opts.db, now), await waitingAlerts(opts.db), name, now, await waitingSuggestionIds(opts.db)));
  }));

  app.get("/console/metrics", page(async (request, reply, name) => {
    const includeTest = (request.query as Record<string, string | undefined>).test === "1";
    return html(reply, metricsView(await metricsPage(opts.db, clock(), { includeTest }), name, includeTest));
  }));

  /** A tester's page (#63): the header, then one tab. Undefined for an unknown tester. */
  const testerHtml = async (reply: FastifyReply, id: string, tab: Tab, name: string, notice?: string, code = 200) => {
    const now = await nowFor(id);
    const header = await testerHeader(opts.db, id, now);
    if (!header) return undefined;
    const ctx: ThreadContext = { testerId: id, titles: header.titles, now };
    let content: string;
    if (tab === "console") {
      const data = await consoleTab(opts.db, id);
      content = consoleTabHtml(data, header.tester, ctx, side(data, ctx).html, CHUNK);
    } else if (tab === "texts") content = textsTabHtml(await textsChunk(opts.db, header.tester), header.tester, now, CHUNK);
    else if (tab === "memory") content = memoryTabHtml(await memoryCards(opts.db, header.tester, now), id);
    else content = progressTabHtml(header.goals, await progressTab(opts.db, header.tester), id, header.titles);
    return html(reply, testerView(header, tab, content, name, notice), code);
  };

  app.get("/console/testers/:id", page(async (request, reply, name) => {
    const { id } = request.params;
    if (!isUuid(id)) return html(reply, "Not found", 404);
    return (await testerHtml(reply, id, asTab(query(request).tab), name)) ?? html(reply, "Not found", 404);
  }));

  // One memory page (#63), only under its own tester.
  app.get("/console/testers/:id/memory/:pid", page(async (request, reply, name) => {
    const { id, pid } = request.params;
    if (!isUuid(id) || !isUuid(pid)) return html(reply, "Not found", 404);
    const header = await testerHeader(opts.db, id, await nowFor(id));
    const view = header && (await memoryPageView(opts.db, id, pid));
    if (!header || !view) return html(reply, "Not found", 404);
    return html(reply, testerView(header, "memory", memoryPageHtml(view, id), name));
  }));

  // Older items for a thread, as the founder scrolls up (#63).
  app.get("/console/testers/:id/thread", action(async (request, reply) => {
    const { id } = request.params;
    const before = cursor(query(request).before);
    if (!isUuid(id) || !before) return reply.code(404).send({ error: "not found" });
    const now = await nowFor(id);
    const header = await testerHeader(opts.db, id, now);
    if (!header) return reply.code(404).send({ error: "not found" });
    const items = await threadChunk(opts.db, id, { before });
    const html = threadItemsHtml(items, { testerId: id, titles: header.titles, now });
    return reply.header("cache-control", "no-store").send({ html, before: items.length >= CHUNK ? String(items[0]!.at.getTime()) : null });
  }));

  app.get("/console/testers/:id/texts", action(async (request, reply) => {
    const { id } = request.params;
    const before = cursor(query(request).before);
    if (!isUuid(id) || !before) return reply.code(404).send({ error: "not found" });
    const [tester] = await opts.db.select().from(testers).where(eq(testers.id, id));
    if (!tester) return reply.code(404).send({ error: "not found" });
    const texts = await textsChunk(opts.db, tester, { before });
    return reply
      .header("cache-control", "no-store")
      .send({ html: textItemsHtml(texts, testerNow(tester, clock())), before: texts.length >= CHUNK ? String(texts[0]!.createdAt.getTime()) : null });
  }));

  // Live updates (#63): what's new after the page's cursors, checked every few seconds while it's visible.
  app.get("/console/testers/:id/updates", action(async (request, reply) => {
    const { id } = request.params;
    if (!isUuid(id)) return reply.code(404).send({ error: "not found" });
    const [tester] = await opts.db.select().from(testers).where(eq(testers.id, id));
    if (!tester) return reply.code(404).send({ error: "not found" });
    const now = testerNow(tester, clock());
    const out: Record<string, unknown> = {};
    const threadAfter = cursor(query(request).thread);
    if (threadAfter) {
      const header = await testerHeader(opts.db, id, now);
      const ctx: ThreadContext = { testerId: id, titles: header!.titles, now };
      const items = await threadChunk(opts.db, id, { after: threadAfter }, LIVE_MAX);
      out.thread = { html: threadItemsHtml(items, ctx), after: String(newest(items.map((i) => i.at), threadAfter).getTime()) };
      out.thinking = thinkingLabel(coachThinking(await recentLines(opts.db, id), now));
      out.side = side(await sideSection(opts.db, id), ctx);
    }
    // #105: the chat cards the page still shows as live, as they stand now (it swaps any whose signature changed).
    const ids = String(query(request).live ?? "").split(",").filter(isUuid).slice(0, LIVE_CARDS);
    if (ids.length) {
      const header = await testerHeader(opts.db, id, now);
      const ctx: ThreadContext = { testerId: id, titles: header!.titles, now };
      out.cards = (await liveItems(opts.db, id, ids)).map((item) => {
        const html = itemHtml(item, ctx);
        return { id: item.id, sig: /data-sig="([^"]+)"/.exec(html)?.[1] ?? "", html };
      });
    }
    const textsAfter = cursor(query(request).texts);
    if (textsAfter) {
      const texts = await textsChunk(opts.db, tester, { after: textsAfter }, LIVE_MAX);
      out.texts = { html: textItemsHtml(texts, now), after: String(newest(texts.map((m) => m.createdAt), textsAfter).getTime()) };
    }
    return reply.header("cache-control", "no-store").send(out);
  }));

  app.post<{ Body: Form }>("/console/login", async (request, reply) => {
    if (!configured) return html(reply, notConfiguredPage(), 503);
    if (!passwordMatches(request.body?.password, opts.password!)) {
      request.log.warn("Console login with a wrong password");
      return html(reply, loginPage("That's not it."), 401);
    }
    return reply.header("set-cookie", sessionCookie(encodeSession(newSession(clock()), opts.sessionSecret!))).redirect("/console", 303);
  });

  app.post<{ Body: Form }>("/console/name", async (request, reply) => {
    if (!configured) return html(reply, notConfiguredPage(), 503);
    const session = sessionOf(request);
    if (!session) return html(reply, loginPage(), 401);
    const name = request.body?.name;
    if (!name || !names.includes(name)) return html(reply, namePage(names), 400);
    // Keeps the login's expiry: picking a name doesn't extend it.
    return reply.header("set-cookie", sessionCookie(encodeSession({ ...session, name }, opts.sessionSecret!), (session.exp - clock().getTime()) / 1000)).redirect("/console", 303);
  });

  app.post("/console/logout", async (_request, reply) => reply.header("set-cookie", clearedSessionCookie()).redirect("/console", 303));

  app.post("/console/testers/:id/alerts/:aid/seen", action(async (request, reply, name) => {
    const { id, aid } = request.params;
    if (!isUuid(id) || !isUuid(aid)) return reply.code(404).send({ error: "not found" });
    const alert = await markAlertSeen(opts.db, { testerId: id, alertId: aid, by: name, at: await nowFor(id) });
    if (!alert) return reply.code(404).send({ error: "not found" });
    return back(reply, id, "console");
  }));

  // #69: asks ZOH about an alert in the chat. It marks, decides and sends nothing.
  app.post("/console/testers/:id/alerts/:aid/discuss", action(async (request, reply, name) => {
    const { id, aid } = request.params;
    if (!isUuid(id) || !isUuid(aid)) return reply.code(404).send({ error: "not found" });
    const [tester] = await opts.db.select().from(testers).where(eq(testers.id, id));
    const [alert] = await opts.db
      .select()
      .from(consoleMessages)
      .where(and(eq(consoleMessages.id, aid), eq(consoleMessages.testerId, id), eq(consoleMessages.kind, "alert")));
    if (!tester || !alert) return reply.code(404).send({ error: "not found" });
    const body = `About the alert [${alert.id.slice(0, 8)}] "${alert.body}" (${(alert.topic ?? "alert").replaceAll("_", " ")}): what happened, why does it matter, and where does it stand now?`;
    return chatLine(request, reply, tester, name, body);
  }));

  app.post("/console/testers/:id/suggestions/:sid/decide", action(async (request, reply, name) => {
    const { id, sid } = request.params;
    if (!isUuid(id) || !isUuid(sid)) return reply.code(404).send({ error: "not found" });
    const decision = parseDecision(request.body ?? {});
    if (!decision) return reply.code(400).send({ error: "a decision (and, for a change, a kind and proposal) is needed" });
    try {
      await decideSuggestion(opts.db, { testerId: id, suggestionId: sid, by: name, at: await nowFor(id), ...decision });
    } catch (err) {
      // The page again, saying why ("Someone else just decided it"), with the decision that stands.
      if (err instanceof SuggestionError) return (await testerHtml(reply, id, "console", name, `Not saved: ${err.message}.`, 409)) ?? reply.code(409).send({ error: err.message });
      throw err;
    }
    return back(reply, id, "pending");
  }));

  // The console chat (spec 4): the founder's line is stored now; the coach answers in the background.
  app.post("/console/testers/:id/chat", action(async (request, reply, name) => {
    const { id } = request.params;
    if (!isUuid(id)) return reply.code(404).send({ error: "not found" });
    const body = request.body?.text?.trim();
    if (!body || body.length > MAX_CHAT_CHARS) return reply.code(400).send({ error: `a message of 1 to ${MAX_CHAT_CHARS} characters is needed` });
    const [tester] = await opts.db.select().from(testers).where(eq(testers.id, id));
    if (!tester) return reply.code(404).send({ error: "not found" });
    return chatLine(request, reply, tester, name, body);
  }));

  // #155: a founder confirms what the console chat drafted. It happens once, re-checked as things stand now.
  app.post("/console/testers/:id/drafts/:did/confirm", action(async (request, reply, name) => {
    const { id, did } = request.params;
    if (!isUuid(id) || !isUuid(did)) return reply.code(404).send({ error: "not found" });
    const [tester] = await opts.db.select().from(testers).where(eq(testers.id, id));
    if (!tester) return reply.code(404).send({ error: "not found" });
    if (!owns(routing, tester.phone, tester.route)) {
      const why = `This number is on ${routeOf(routing, tester.phone, tester.route)} right now, so this console can't act for them.`;
      return (await testerHtml(reply, id, "console", name, `Not done: ${why}`, 409)) ?? reply.code(409).send({ error: why });
    }
    const done = await confirmDraft(opts.db, { testerId: id, draftId: did, founder: name, now: testerNow(tester, clock()) });
    if (!done.ok) return (await testerHtml(reply, id, "console", name, `Not done: ${done.error}.`, 409)) ?? reply.code(409).send({ error: done.error });
    return back(reply, id, "chat");
  }));

  app.post("/console/testers/:id/drafts/:did/cancel", action(async (request, reply, name) => {
    const { id, did } = request.params;
    if (!isUuid(id) || !isUuid(did)) return reply.code(404).send({ error: "not found" });
    const row = await cancelDraft(opts.db, { testerId: id, draftId: did, by: name });
    if (!row) return reply.code(409).send({ error: "not a draft any more" });
    return back(reply, id, "chat");
  }));

  app.post("/console/testers/:id/requests/:rid/cancel", action(async (request, reply) => {
    const { id, rid } = request.params;
    if (!isUuid(id) || !isUuid(rid)) return reply.code(404).send({ error: "not found" });
    const row = await cancelRequest(opts.db, { testerId: id, requestId: rid, at: await nowFor(id) });
    if (!row) return reply.code(409).send({ error: "not pending any more" });
    return back(reply, id, "chat");
  }));

  // Proof photos and voice notes, streamed from our private bucket.
  app.get("/console/media/:mid", action(async (request, reply) => {
    const { mid } = request.params;
    if (!isUuid(mid) || !opts.media) return reply.code(404).send({ error: "not found" });
    const message = await mediaMessage(opts.db, mid);
    const object = message?.mediaKey ? await opts.media.get(message.mediaKey) : undefined;
    if (!object) return reply.code(404).send({ error: "not found" });
    reply
      .header("cache-control", "private, max-age=3600")
      .header("x-content-type-options", "nosniff")
      // A tester's file (an SVG, an HTML attachment) opened on its own never runs script as a logged-in founder.
      .header("content-security-policy", "sandbox")
      .header("accept-ranges", "bytes")
      .type(message!.mediaContentType ?? object.contentType);
    const bytes = Buffer.from(object.bytes);
    // #97: Safari won't play audio unless it can ask for pieces of it.
    const wanted = request.headers.range;
    if (!wanted) return reply.send(bytes);
    const range = byteRange(wanted, bytes.length);
    if (!range) return reply.code(416).header("content-range", `bytes */${bytes.length}`).send();
    return reply
      .code(206)
      .header("content-range", `bytes ${range.start}-${range.end}/${bytes.length}`)
      .send(bytes.subarray(range.start, range.end + 1));
  }));

  // For "Add to Home Screen": nothing about testers here.
  app.get("/console/manifest.webmanifest", async (_request, reply) => reply.type("application/manifest+json").send(MANIFEST));
  app.get("/console/icon.svg", async (_request, reply) => reply.header("cache-control", "public, max-age=86400").type("image/svg+xml").send(ICON_SVG));
  let png: Promise<Buffer> | undefined;
  app.get("/console/icon.png", async (_request, reply) => {
    png ??= sharp(Buffer.from(ICON_SVG)).resize(180, 180).png().toBuffer();
    return reply.header("cache-control", "public, max-age=86400").type("image/png").send(await png);
  });
}

/** One "bytes=a-b", "bytes=a-" or "bytes=-n" range within `size`; undefined when it can't be served. */
export function byteRange(header: string, size: number): { start: number; end: number } | undefined {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2]) || size === 0) return undefined;
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  return start <= end && start < size ? { start, end } : undefined;
}

function asKind(value: string | undefined): SuggestionKind | undefined {
  return (SUGGESTION_KINDS as readonly string[]).includes(value ?? "") ? (value as SuggestionKind) : undefined;
}

function parseDecision(body: Form): Decision | undefined {
  const reason = body.reason?.trim() || undefined;
  if (body.decision === "approved") return { decision: "approved", reason };
  if (body.decision === "rejected") return { decision: "rejected", reason };
  if (body.decision === "changed") {
    const kind = asKind(body.kind);
    const proposal = body.proposal?.trim();
    return kind && proposal ? { decision: "changed", kind, proposal, reason } : undefined;
  }
  return undefined;
}

/** A cursor from the page: milliseconds since the epoch. */
function cursor(value: unknown): Date | undefined {
  return typeof value === "string" && /^\d{1,15}$/.test(value) ? new Date(Number(value)) : undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
