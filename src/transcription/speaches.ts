/**
 * Voice-note transcription through Speaches (faster-whisper, OpenAI-compatible API),
 * running as its own Railway service on the private network.
 */
export interface Transcriber {
  transcribe(audio: Uint8Array, filename: string, contentType: string): Promise<string>;
  check(): Promise<void>;
}

export interface SpeachesOptions {
  url: string;
  apiKey?: string;
  model: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function createSpeachesTranscriber(opts: SpeachesOptions): Transcriber {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const auth: Record<string, string> = opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {};

  async function requestTranscription(audio: Uint8Array, filename: string, contentType: string) {
    const form = new FormData();
    form.append("file", new Blob([audio], { type: contentType }), filename);
    form.append("model", opts.model);
    form.append("response_format", "json");
    return doFetch(`${opts.url}/v1/audio/transcriptions`, {
      method: "POST",
      headers: auth,
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  /** Speaches only serves models it has downloaded; this fetches one onto its volume. */
  async function downloadModel(): Promise<void> {
    const res = await doFetch(`${opts.url}/v1/models/${opts.model}`, {
      method: "POST",
      headers: auth,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok && res.status !== 409) {
      throw new Error(`Speaches model download failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
  }

  return {
    async transcribe(audio, filename, contentType) {
      let res = await requestTranscription(audio, filename, contentType);
      if (res.status === 404) {
        await downloadModel();
        res = await requestTranscription(audio, filename, contentType);
      }
      if (!res.ok) {
        throw new Error(`Speaches transcription failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
      }
      const body = (await res.json()) as { text?: string };
      return (body.text ?? "").trim();
    },
    async check() {
      const res = await doFetch(`${opts.url}/health`, { headers: auth, signal: AbortSignal.timeout(5_000) });
      if (!res.ok) throw new Error(`Speaches health returned HTTP ${res.status}`);
    },
  };
}
