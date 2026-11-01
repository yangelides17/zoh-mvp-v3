import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { normalizePhone } from "../config.js";
import { insertInboundOnce, updateStatusByHandle } from "../db/messages.js";
import type { Db } from "../db/client.js";
import { processEnvReply, processInbound, maskNumber, routingOf, type PipelineDeps } from "../pipeline/inbound.js";
import { ownsNumber, parseEnv, type AppEnv } from "../testers/env.js";
import { getOrCreateTester, getTesterByPhone, updateTester } from "../testers/testers.js";
import type { TaskQueue } from "../pipeline/task-queue.js";
import { isJumpText } from "../testers/commands.js";
import type { Jumper } from "../testers/jump.js";
import { sendblueMessageEvent } from "../sendblue/webhook-payload.js";

/** Sendblue sends the configured secret verbatim in this header. */
export const SECRET_HEADER = "sb-signing-secret";

export interface WebhookRouteOptions {
  webhookSecret?: string;
  pipeline: PipelineDeps;
  queue: TaskQueue;
  jumper?: Jumper;
}

export async function webhookRoutes(app: FastifyInstance, opts: WebhookRouteOptions): Promise<void> {
  app.post("/webhooks/sendblue", async (request, reply) => {
    const receivedAt = new Date();

    if (!opts.webhookSecret) {
      request.log.warn("SENDBLUE_WEBHOOK_SECRET is not set; refusing webhook");
      return reply.code(503).send({ error: "webhook secret not configured" });
    }
    if (!secretMatches(request.headers[SECRET_HEADER], opts.webhookSecret)) {
      request.log.warn({ headerNames: Object.keys(request.headers) }, "Webhook secret missing or wrong");
      return reply.code(401).send({ error: "unauthorized" });
    }

    const parsed = sendblueMessageEvent.safeParse(request.body);
    if (!parsed.success) {
      request.log.warn({ issues: parsed.error.issues.slice(0, 5) }, "Unrecognized webhook body");
      // 2xx so Sendblue doesn't retry something we will never accept.
      return reply.code(202).send({ ignored: "unrecognized payload" });
    }
    const event = parsed.data;
    const db = opts.pipeline.db;

    // Our own outgoing messages come back as status updates: record them, never reply.
    if (event.is_outbound) {
      const updated = await updateStatusByHandle(
        db,
        event.message_handle,
        event.status ?? "UNKNOWN",
        event.error_key ?? event.error_message ?? null,
      );
      return reply.code(200).send({ ok: true, outbound: true, updated });
    }

    if (event.group_id) {
      request.log.info("Group message ignored");
      return reply.code(200).send({ ok: true, ignored: "group" });
    }

    const contact = normalizePhone(event.number ?? event.from_number ?? "");
    if (!contact) return reply.code(202).send({ ignored: "no sender number" });
    const line = event.sendblue_number ?? event.to_number;
    const { devNumbers, allowedNumbers } = opts.pipeline;
    const routing = routingOf(opts.pipeline);
    const store = () =>
      insertInboundOnce(db, {
        contactNumber: contact,
        lineNumber: line ? normalizePhone(line) : null,
        content: event.content ?? null,
        mediaUrl: event.media_url ? event.media_url : null,
        sendblueHandle: event.message_handle,
        service: event.service ?? null,
        status: event.status ?? "RECEIVED",
        sentAt: parseDate(event.date_sent),
        timings: { webhook_received_at: receivedAt.toISOString() },
        raw: event,
      });

    // Staging and production (#82): a dev number's "env" is read by both apps, before anything is stored.
    const env = !event.media_url && devNumbers.includes(contact) && allowedNumbers.includes(contact) ? parseEnv(event.content) : undefined;
    if (env) {
      if (env.kind === "switch") await saveRoute(db, contact, env.to, receivedAt);
      const mine = env.kind === "switch" ? env.to === routing.appEnv : await ownsNumber(db, routing, contact);
      if (!mine) {
        request.log.info({ appEnv: routing.appEnv }, "env for the other app: route saved, nothing stored");
        return reply.code(200).send({ ok: true, ignored: "other environment" });
      }
      const stored = await store();
      if (!stored) return reply.code(200).send({ ok: true, duplicate: true });
      request.log.info({ messageId: stored.id, contact: maskNumber(contact), appEnv: routing.appEnv }, "env answered here");
      opts.queue.run(() => processEnvReply(opts.pipeline, stored));
      return reply.code(200).send({ ok: true, id: stored.id, env: true });
    }

    // A number the other app owns: nothing is stored, sent or logged with the number.
    if (!(await ownsNumber(db, routing, contact))) {
      request.log.info({ appEnv: routing.appEnv }, "Text for the other app dropped");
      return reply.code(200).send({ ok: true, ignored: "other environment" });
    }

    // Test mode (#14): a dev account's "jump" is a ghost: never stored as a message, run in the background.
    if (opts.jumper && !event.media_url && isJumpText(event.content) && devNumbers.includes(contact) && allowedNumbers.includes(contact)) {
      const jump = await opts.jumper.start({ contact, text: event.content!.trim(), handle: event.message_handle });
      if (!jump) return reply.code(200).send({ ok: true, duplicate: true });
      opts.queue.run(() => jump.done);
      request.log.info({ contact: maskNumber(contact) }, "Jump started");
      return reply.code(200).send({ ok: true, jump: true });
    }

    const inbound = await store();
    if (!inbound) {
      request.log.info({ handle: event.message_handle }, "Duplicate webhook delivery ignored");
      return reply.code(200).send({ ok: true, duplicate: true });
    }

    request.log.info(
      { messageId: inbound.id, contact: maskNumber(contact), hasMedia: Boolean(inbound.mediaUrl) },
      "Inbound message stored",
    );
    // Answer Sendblue now; the reply happens in the background.
    opts.queue.run(() => processInbound(opts.pipeline, inbound));
    return reply.code(200).send({ ok: true, id: inbound.id });
  });
}

/**
 * Saves where a dev number now goes (#82). Each app saves it in its own database, so both agree.
 * No row means production, so switching to production needs none.
 */
async function saveRoute(db: Db, phone: string, to: AppEnv, at: Date): Promise<void> {
  const existing = await getTesterByPhone(db, phone);
  if (!existing && to === "production") return;
  const tester = existing ?? (await getOrCreateTester(db, phone, { firstTextAt: at, isTestUser: true }));
  if (tester.route !== to) await updateTester(db, tester.id, { route: to });
}

function secretMatches(header: string | string[] | undefined, expected: string): boolean {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
