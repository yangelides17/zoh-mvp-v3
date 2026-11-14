import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A voice note in a box every browser plays: the same audio, no re-encoding. */
export interface Rewrapped {
  bytes: Uint8Array;
  ext: "m4a" | "ogg";
  contentType: string;
}

/**
 * #185: iPhone voice notes arrive as Core Audio files (.caf), which Chrome can't play. This moves
 * the audio, untouched, into .m4a (AAC) or .ogg (Opus). System ffmpeg (a Railway apt package);
 * tests use a fake.
 */
export interface AudioRewrapper {
  rewrap(caf: Uint8Array): Promise<Rewrapped>;
  check(): Promise<void>;
}

export function createFfmpegRewrapper(opts: { timeoutMs?: number } = {}): AudioRewrapper {
  const timeout = opts.timeoutMs ?? 30_000;
  return {
    async rewrap(caf) {
      const dir = await mkdtemp(join(tmpdir(), "rewrap-"));
      try {
        const input = join(dir, "in.caf");
        await writeFile(input, caf);
        const { stdout } = await run(
          "ffprobe",
          ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", input],
          { timeout },
        );
        const codec = stdout.trim();
        const out = codec === "opus" ? { ext: "ogg" as const, contentType: "audio/ogg" } : codec === "aac" ? { ext: "m4a" as const, contentType: "audio/mp4" } : undefined;
        if (!out) throw new Error(`No browser-friendly box for codec "${codec}"`);
        const output = join(dir, `out.${out.ext}`);
        await run("ffmpeg", ["-v", "error", "-y", "-i", input, "-c", "copy", output], { timeout });
        return { bytes: new Uint8Array(await readFile(output)), ...out };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    async check() {
      await run("ffmpeg", ["-version"], { timeout });
    },
  };
}
