import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A voice note in a box every browser plays (.m4a, AAC), plus the codec it arrived in. */
export interface Rewrapped {
  bytes: Uint8Array;
  ext: "m4a";
  contentType: string;
  codec: string;
}

/**
 * #185: iPhone voice notes arrive as Core Audio files (.caf), which Chrome can't play. AAC moves into .m4a
 * untouched; anything else is re-encoded to AAC (#217: iMessage notes are Opus, and Apple's .caf has no Opus
 * header, so they can't be copied into .ogg). System ffmpeg (a Railway apt package); tests use a fake.
 */
export interface AudioRewrapper {
  rewrap(caf: Uint8Array): Promise<Rewrapped>;
  check(): Promise<void>;
}

export function createFfmpegRewrapper(opts: { timeoutMs?: number } = {}): AudioRewrapper {
  const timeout = opts.timeoutMs ?? 30_000;
  const probe = async (file: string, entries: string) =>
    (await run("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", entries, "-of", "csv=p=0", file], { timeout })).stdout.trim();
  return {
    async rewrap(caf) {
      const dir = await mkdtemp(join(tmpdir(), "rewrap-"));
      try {
        const input = join(dir, "in.caf");
        const output = join(dir, "out.m4a");
        await writeFile(input, caf);
        const codec = await probe(input, "stream=codec_name");
        const audio = codec === "aac" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "64k"];
        await run("ffmpeg", ["-v", "error", "-y", "-i", input, "-vn", ...audio, "-movflags", "+faststart", output], { timeout });
        // A file with no length is the silent 0:00 player again: keep the .caf instead.
        const seconds = Number(await probe(output, "format=duration"));
        if (!(seconds > 0)) throw new Error(`Converted "${codec}" voice note has no length`);
        return { bytes: new Uint8Array(await readFile(output)), ext: "m4a", contentType: "audio/mp4", codec };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    async check() {
      await run("ffmpeg", ["-version"], { timeout });
    },
  };
}
