import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { normalizePhone } from "../config.js";
import { insertInboundOnce, updateStatusByHandle } from "../db/messages.js";
import { processInbound, maskNumber, type PipelineDeps } from "../pipeline/inbound.js";
import type { TaskQueue } from "../pipeline/task-queue.js";
import { sendblueMessageEvent } from "../sendblue/webhook-payload.js";

/** Sendblue sends the configured secret verbatim in this header. */
export const SECRET_HEADER = "sb-signing-secret";

export interface WebhookRouteOptions {
  webhookSecret?: string;
  pipeline: PipelineDeps;
  queue: TaskQueue;
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

    const inbound = await insertInboundOnce(db, {
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
