import { z } from "zod";

/**
 * Sendblue message webhook body (receive + outbound status events).
 * Lenient on purpose: unknown fields pass through and most fields may be null.
 * https://docs.sendblue.com/getting-started/webhooks/
 */
export const sendblueMessageEvent = z.looseObject({
  message_handle: z.string().min(1),
  is_outbound: z.boolean(),
  content: z.string().nullish(),
  media_url: z.string().nullish(),
  status: z.string().nullish(),
  error_code: z.union([z.number(), z.string()]).nullish(),
  error_message: z.string().nullish(),
  error_key: z.string().nullish(),
  date_sent: z.string().nullish(),
  date_updated: z.string().nullish(),
  from_number: z.string().nullish(),
  to_number: z.string().nullish(),
  /** The end user's number. */
  number: z.string().nullish(),
  sendblue_number: z.string().nullish(),
  service: z.string().nullish(),
  message_type: z.string().nullish(),
  group_id: z.string().nullish(),
});

export type SendblueMessageEvent = z.infer<typeof sendblueMessageEvent>;

/**
 * Sendblue typing-indicator webhook body (#16): the tester started or stopped typing (iMessage only).
 * https://docs.sendblue.com/api-v2/typing-indicators/
 */
export const sendblueTypingEvent = z.looseObject({
  /** The tester's number. */
  number: z.string().min(1),
  is_typing: z.boolean(),
  /** Our line. */
  from_number: z.string().nullish(),
  /** When Sendblue saw it (ISO 8601). */
  timestamp: z.string().nullish(),
});

export type SendblueTypingEvent = z.infer<typeof sendblueTypingEvent>;
