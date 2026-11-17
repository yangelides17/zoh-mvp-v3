import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createFfmpegRewrapper } from "../src/media/rewrap.js";

const run = promisify(execFile);

function installed(cmd: string): boolean {
  try {
    execFileSync(cmd, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// CI installs ffmpeg and must run this; a laptop without it skips.
const runIt = installed("ffmpeg") && installed("ffprobe");
const required = process.env.CI === "true";

/** What a browser would see: the audio codec and length of the stored file. */
async function probe(bytes: Uint8Array, ext: string): Promise<{ codec: string; seconds: number }> {
  const dir = await mkdtemp(join(tmpdir(), "probe-"));
  try {
    const file = join(dir, `out.${ext}`);
    await writeFile(file, bytes);
    const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name:format=duration", "-of", "json", file]);
    const json = JSON.parse(stdout) as { streams: { codec_name: string }[]; format: { duration: string } };
    return { codec: json.streams[0]!.codec_name, seconds: Number(json.format.duration) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!runIt && !required)("#217: a real iPhone-style voice note plays in Chrome", () => {
  // Made on a Mac the way iMessage does it: `say` → `afconvert -f caff -d opus` (mono, 24 kHz Opus in .caf).
  const fixture = new URL("./fixtures/voice-opus.caf", import.meta.url);

  it("turns an Opus .caf into AAC .m4a with its real length", async () => {
    const caf = new Uint8Array(await readFile(fixture));
    const out = await createFfmpegRewrapper().rewrap(caf);
    expect(out.ext).toBe("m4a");
    expect(out.contentType).toBe("audio/mp4");
    const stored = await probe(out.bytes, out.ext);
    expect(stored.codec).toBe("aac");
    expect(stored.seconds).toBeGreaterThan(1.7);
    expect(stored.seconds).toBeLessThan(2.3);
  });
});
