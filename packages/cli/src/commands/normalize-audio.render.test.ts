import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getFfmpegBinary, processCompositionAudio } from "@hyperframes/engine";
import { absoluteLoudnessPlan, measureAudio } from "@hyperframes/studio-server/loudness";

const FFMPEG = getFfmpegBinary();
const HAS_FFMPEG = spawnSync(FFMPEG, ["-version"]).status === 0;
const WINDOW = { mediaStart: 0, duration: null };
const tempDirs: string[] = [];

// Real ffmpeg, like the engine's audioMixer.level.test.ts.
describe.skipIf(!HAS_FFMPEG)(
  "normalize-audio through render",
  () => {
    afterEach(() => {
      for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    it("a mono clip normalized to -14 LUFS renders at -14 LUFS", async () => {
      const projectDir = mkdtempSync(join(tmpdir(), "hf-normalize-render-"));
      const workDir = mkdtempSync(join(tmpdir(), "hf-normalize-work-"));
      tempDirs.push(projectDir, workDir);
      const source = join(projectDir, "a-roll.wav");
      const rendered = join(projectDir, "audio.aac");
      const lavfi = "sine=frequency=440:duration=5:sample_rate=48000";
      const setup = spawnSync(
        FFMPEG,
        ["-v", "error", "-f", "lavfi", "-i", lavfi, "-ac", "1", source],
        {
          encoding: "utf-8",
        },
      );
      expect(setup.status, setup.stderr).toBe(0);

      const measured = await measureAudio(FFMPEG, source, WINDOW);
      const plan = absoluteLoudnessPlan({ id: "a-roll", volume: 1, ...measured }, -14);
      expect(plan.limitedBy).toBeNull();

      const result = await processCompositionAudio(
        [
          {
            id: "a-roll",
            src: "a-roll.wav",
            start: 0,
            end: 5,
            mediaStart: 0,
            layer: 0,
            volume: plan.volume,
            type: "audio",
          },
        ],
        projectDir,
        workDir,
        rendered,
        5,
      );
      expect(result.success).toBe(true);

      const output = await measureAudio(FFMPEG, rendered, WINDOW);
      expect(Math.abs(output.integratedLufs - -14)).toBeLessThanOrEqual(0.5);
    });
  },
  30_000,
);
