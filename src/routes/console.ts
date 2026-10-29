import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import sharp from "sharp";
import type { ConsoleConfig } from "../config.js";
import { markAlertSeen } from "../console/alerts.js";
import { clearedSessionCookie, decodeSession, encodeSession, newSession, parseCookies, passwordMatches, SESSION_COOKIE, sessionCookie, type Session } from "../console/auth.js";
import { mediaMessage, testerPage, testerRows, waitingAlerts } from "../console/data.js";
import { addFounderSuggestion, decideSuggestion, SuggestionError, type Decision, type SuggestionKind } from "../console/suggestions.js";
import { metricsPage } from "../console/metrics.js";
import { ICON_SVG, loginPage, listPage, MANIFEST, metricsView, namePage, notConfiguredPage, testerView } from "../console/views.js";
import { postFounderMessage, type ConsoleCoach } from "../console/chat.js";
import { addThreadLine, cancelRequest, COACH_AUTHOR } from "../console/requests.js";
import type { Db } from "../db/client.js";
import { SUGGESTION_KINDS, testers } from "../db/schema.js";
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
  now?: () => Date;
}

/** Longest message the chat box takes. */
export const MAX_CHAT_CHARS = 2000;

type Form = Record<string, string | undefined>;
type Params = { id: string; sid: string; aid: string; mid: string; rid: string };

export async function consoleRoutes(app: FastifyInstance, opts: ConsoleRouteOptions): Promise<void> {
  const clock = opts.now ?? (() => new Date());
  const configured = Boolean(opts.password && opts.sessionSecret);
  const names = opts.names.length ? opts.names : ["Founder"];

  // Plain HTML forms; scoped to this plugin.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  const html = (reply: FastifyReply, page: string, code = 200) =>
    reply.code(code).header("cache-control", "no-store").header("x-robots-tag", "noindex").type("text/html; charset=utf-8").send(page);

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

  const back = (reply: FastifyReply, testerId: string, hash: string) => reply.redirect(`/console/testers/${encodeURIComponent(testerId)}#${hash}`, 303);

  app.get("/console", page(async (_request, reply, name) => {
    const now = clock();
    return html(reply, listPage(await testerRows(opts.db, now), await waitingAlerts(opts.db), name));
  }));

  app.get("/console/metrics", page(async (request, reply, name) => {
    const includeTest = (request.query as Record<string, string | undefined>).test === "1";
    return html(reply, metricsView(await metricsPage(opts.db, clock(), { includeTest }), name, includeTest));
  }));

  app.get("/console/testers/:id", page(async (request, reply, name) => {
    if (!isUuid(request.params.id)) return html(reply, "Not found", 404);
    const data = await testerPage(opts.db, request.params.id, clock());
    if (!data) return html(reply, "Not found", 404);
    return html(reply, testerView(data, name, clock()));
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
    const alert = await markAlertSeen(opts.db, { testerId: id, alertId: aid, by: name, at: clock() });
    if (!alert) return reply.code(404).send({ error: "not found" });
    return back(reply, id, "console");
  }));

  app.post("/console/testers/:id/suggestions/:sid/decide", action(async (request, reply, name) => {
    const { id, sid } = request.params;
    if (!isUuid(id) || !isUuid(sid)) return reply.code(404).send({ error: "not found" });
    const decision = parseDecision(request.body ?? {});
    if (!decision) return reply.code(400).send({ error: "a decision (and, for a change, a kind and proposal) is needed" });
    try {
      await decideSuggestion(opts.db, { testerId: id, suggestionId: sid, by: name, at: clock(), ...decision });
    } catch (err) {
      if (err instanceof SuggestionError) return reply.code(409).send({ error: err.message });
      throw err;
    }
    return back(reply, id, "suggestions");
  }));

  app.post("/console/testers/:id/suggestions", action(async (request, reply, name) => {
    const { id } = request.params;
    if (!isUuid(id)) return reply.code(404).send({ error: "not found" });
    const body = request.body ?? {};
    const kind = asKind(body.kind);
    const proposal = body.proposal?.trim();
    if (!kind || !proposal || !body.goal) return reply.code(400).send({ error: "goal, kind and proposal are needed" });
    try {
      await addFounderSuggestion(opts.db, {
        testerId: id,
        goalSlug: body.goal,
        kind,
        proposal,
        reasoning: body.reasoning,
        newGoalSlug: body.newGoal || undefined,
        by: name,
        at: clock(),
      });
    } catch (err) {
      if (err instanceof SuggestionError) return reply.code(400).send({ error: err.message });
      // A tester or goal that doesn't exist (a foreign key) is the founder's mistake, not ours.
      if ((err as { cause?: { code?: string } }).cause?.code === "23503" || (err as { code?: string }).code === "23503") return reply.code(400).send({ error: "unknown tester or goal" });
      throw err;
    }
    return back(reply, id, "suggestions");
  }));

  // The console chat (spec 4): the founder's line is stored now; the coach answers in the background.
  app.post("/console/testers/:id/chat", action(async (request, reply, name) => {
    const { id } = request.params;
    if (!isUuid(id)) return reply.code(404).send({ error: "not found" });
    const body = request.body?.text?.trim();
    if (!body || body.length > MAX_CHAT_CHARS) return reply.code(400).send({ error: `a message of 1 to ${MAX_CHAT_CHARS} characters is needed` });
    const [tester] = await opts.db.select().from(testers).where(eq(testers.id, id));
    if (!tester) return reply.code(404).send({ error: "not found" });
    const now = clock();
    const exact = request.body?.exact === "on";
    const { needsAnswer } = await postFounderMessage(opts.db, { tester, founder: name, body, exact, sendNow: exact && request.body?.sendNow === "on", now });
    if (needsAnswer) {
      const answer = async () => {
        try {
          if (!opts.chat) throw new Error("The console coach isn't set up (no Claude key).");
          await opts.chat.answer(id, clock());
        } catch (err) {
          request.log.error({ err: safeError(err) }, "Console coach failed");
          const why = err instanceof Error && err.message.startsWith("The console coach") ? err.message : "Sorry, I couldn't answer that just now. Try again?";
          // ZOH's line, so it counts as the answer and the page stops waiting.
          await addThreadLine(opts.db, { testerId: id, kind: "coach", author: COACH_AUTHOR, body: why, at: clock() });
        }
      };
      if (opts.queue) opts.queue.run(answer);
      else await answer();
    }
    return back(reply, id, "chat");
  }));

  app.post("/console/testers/:id/requests/:rid/cancel", action(async (request, reply) => {
    const { id, rid } = request.params;
    if (!isUuid(id) || !isUuid(rid)) return reply.code(404).send({ error: "not found" });
    const row = await cancelRequest(opts.db, { testerId: id, requestId: rid, at: clock() });
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
    return reply
      .header("cache-control", "private, max-age=3600")
      .header("x-content-type-options", "nosniff")
      // A tester's file (an SVG, an HTML attachment) opened on its own never runs script as a logged-in founder.
      .header("content-security-policy", "sandbox")
      .type(message!.mediaContentType ?? object.contentType)
      .send(Buffer.from(object.bytes));
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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
