import { and, asc, eq, ilike, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { messages } from "../db/schema.js";
import { safeError } from "../errors.js";
import type { Logger } from "../pipeline/inbound.js";
import { AUDIO_EXT, type MediaStore } from "./storage.js";

/** Audio by its type, or by the key's extension when the CDN labeled it vaguely (as `mediaKind` does). */
const isAudio = or(
  ilike(messages.mediaContentType, "audio/%"),
  sql`${messages.mediaKey} ~* ${`\\.(${[...AUDIO_EXT].join("|")})$`}`,
);

/** Voice-note audio stays this long for debugging, then goes; the transcript stays (spec: "Photo and voice verification"). */
export const AUDIO_KEEP_MS = 30 * 86_400_000;
const DEFAULT_TICK_MS = 60 * 60_000;
/** Deletes per tick, so a backlog never makes one tick slow. */
const BATCH = 100;

export interface MediaRetentionDeps {
  db: Db;
  log: Logger;
  media?: MediaStore;
  now?: () => Date;
}

export interface MediaRetention {
  /** Deletes voice-note audio older than 30 days; returns how many went. */
  tick(now?: Date): Promise<number>;
  start(intervalMs?: number): void;
  stop(): Promise<void>;
}

export function createMediaRetention(deps: MediaRetentionDeps): MediaRetention {
  const clock = deps.now ?? (() => new Date());
  let timer: NodeJS.Timeout | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  async function run(now: Date): Promise<number> {
    const media = deps.media;
    if (!media) return 0;
    const rows = await deps.db
      .select({ id: messages.id, mediaKey: messages.mediaKey })
      .from(messages)
      .where(
        and(
          eq(messages.direction, "inbound"),
          isNotNull(messages.mediaKey),
          isAudio,
          isNull(messages.mediaDeletedAt),
          lt(messages.createdAt, new Date(now.getTime() - AUDIO_KEEP_MS)),
        ),
      )
      .orderBy(asc(messages.createdAt))
      .limit(BATCH);
    let deleted = 0;
    // Photos are kept: memory and the founders look back at them. Only audio goes.
    for (const row of rows) {
      await media.delete(row.mediaKey!);
      await deps.db.update(messages).set({ mediaDeletedAt: now, updatedAt: now }).where(eq(messages.id, row.id));
      deleted += 1;
    }
    if (deleted) deps.log.info({ deleted }, "Deleted old voice-note audio");
    return deleted;
  }

  return {
    tick(now = clock()) {
      const next = chain.then(() => run(now));
      chain = next.catch(() => undefined);
      return next;
    },
    start(intervalMs = DEFAULT_TICK_MS) {
      if (timer || !deps.media) return;
      timer = setInterval(() => {
        void this.tick().catch((err: unknown) => deps.log.error({ err: safeError(err) }, "Media retention tick failed"));
      }, intervalMs);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await chain;
    },
  };
}
