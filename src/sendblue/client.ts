/**
 * Thin Sendblue client: only the calls ZOH uses. Docs: https://docs.sendblue.com
 * Keys are sent as headers and never logged.
 */

export interface SendResult {
  messageHandle?: string;
  status?: string;
  raw: unknown;
}

export interface SendblueClient {
  sendMessage(input: { number: string; content?: string; mediaUrl?: string }): Promise<SendResult>;
  /** Best effort: never throws. Returns false if Sendblue declined it. */
  sendTypingIndicator(number: string, state?: "start" | "stop"): Promise<boolean>;
  /**
   * Takes a number off Sendblue's own opt-out list, which it joins when someone texts STOP; Sendblue
   * refuses every send to it until then (issue "Sendblue's own STOP opt-out blocks every reply").
   * Only when they texted us again themselves. Throws if Sendblue refuses.
   */
  optIn(number: string): Promise<void>;
  /**
   * #168: puts a file on Sendblue's media host (at most `MAX_UPLOAD_BYTES`) and returns its media_url, to send with
   * a text. Throws if Sendblue refuses.
   */
  uploadFile(file: { bytes: Uint8Array; contentType: string; name: string }): Promise<string>;
}

/** #168: Sendblue's upload limit (https://docs.sendblue.com/api-v2/media/: "Maximum file size: 100 MB"). */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** #168: an upload can take far longer than a send. */
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

export class SendblueError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly errorKey?: string,
  ) {
    super(message);
    this.name = "SendblueError";
  }
}

export interface SendblueClientOptions {
  baseUrl: string;
  apiKeyId: string;
  apiKeySecret: string;
  /** Our Sendblue line in E.164. */
  fromNumber: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function createSendblueClient(opts: SendblueClientOptions): SendblueClient {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  async function post(path: string, body: Record<string, unknown>): Promise<{ status: number; json: any }> {
    const res = await doFetch(`${opts.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sb-api-key-id": opts.apiKeyId,
        "sb-api-secret-key": opts.apiKeySecret,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text.slice(0, 500) };
    }
    return { status: res.status, json };
  }

  return {
    async sendMessage({ number, content, mediaUrl }) {
      const { status, json } = await post("/api/send-message", {
        number,
        from_number: opts.fromNumber,
        ...(content !== undefined ? { content } : {}),
        ...(mediaUrl !== undefined ? { media_url: mediaUrl } : {}),
      });
      if (status < 200 || status >= 300 || json?.status === "ERROR" || json?.status === "DECLINED") {
        const key = json?.error_key ?? json?.error_message ?? undefined;
        throw new SendblueError(
          `Sendblue send failed (HTTP ${status}${key ? `, ${key}` : ""})`,
          status,
          key,
        );
      }
      return { messageHandle: json?.message_handle, status: json?.status, raw: json };
    },

    async uploadFile({ bytes, contentType, name }) {
      // https://docs.sendblue.com/api-v2/media/: multipart, the file in a field named "file".
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: contentType }), name);
      const res = await doFetch(`${opts.baseUrl}/api/upload-file`, {
        method: "POST",
        headers: { "sb-api-key-id": opts.apiKeyId, "sb-api-secret-key": opts.apiKeySecret },
        body: form,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      const text = await res.text();
      let json: { media_url?: string; error_message?: string; message?: string } = {};
      try {
        json = text ? (JSON.parse(text) as typeof json) : {};
      } catch {
        // Not JSON: handled below as a failure.
      }
      if (res.status < 200 || res.status >= 300 || !json.media_url) {
        throw new SendblueError(`Sendblue upload failed (HTTP ${res.status}${json.error_message ? `, ${json.error_message}` : ""})`, res.status);
      }
      return json.media_url;
    },

    async optIn(number) {
      // https://docs.sendblue.com/api-v2/contacts/
      const { status, json } = await post("/api/v2/contacts/opt-out", { number, opted_out: false });
      if (status < 200 || status >= 300 || json?.status === "ERROR") {
        const key = json?.error_key ?? json?.error_message ?? undefined;
        throw new SendblueError(`Sendblue opt-in failed (HTTP ${status}${key ? `, ${key}` : ""})`, status, key);
      }
    },

    async sendTypingIndicator(number, state = "start") {
      try {
        const body: Record<string, unknown> = { number, from_number: opts.fromNumber, state };
        // Clear on its own after 30s in case the reply never goes out.
        if (state === "start") body.max_duration_ms = 30_000;
        let res = await post("/api/send-typing-indicator", body);
        // Some line firmware rejects explicit durations with 503; plain "start" still works.
        if (res.status === 503 && state === "start") {
          res = await post("/api/send-typing-indicator", { number, from_number: opts.fromNumber });
        }
        return res.status >= 200 && res.status < 300;
      } catch {
        return false;
      }
    },
  };
}
