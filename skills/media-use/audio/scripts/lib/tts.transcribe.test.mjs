import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcribeWav } from "./tts.mjs";

// Fake `npx` first on PATH: behaviour comes from FAKE_NPX_* env, and the
// transcript is written to the --dir argument like `hyperframes transcribe`.
const bin = mkdtempSync(join(tmpdir(), "fake-npx-"));
writeFileSync(
  join(bin, "npx"),
  `#!/bin/sh
while [ $# -gt 0 ]; do [ "$1" = "--dir" ] && dir="$2"; shift; done
[ -n "$FAKE_NPX_JSON" ] && [ -z "$FAKE_NPX_JSON_NONE" ] && echo "$FAKE_NPX_JSON"
[ -n "$FAKE_NPX_STDERR" ] && echo "$FAKE_NPX_STDERR" >&2
[ -n "$FAKE_NPX_TRANSCRIPT" ] && echo "$FAKE_NPX_TRANSCRIPT" > "$dir/transcript.json"
exit \${FAKE_NPX_EXIT:-0}
`,
);
chmodSync(join(bin, "npx"), 0o755);

async function run(env) {
  const keys = ["FAKE_NPX_JSON", "FAKE_NPX_STDERR", "FAKE_NPX_TRANSCRIPT", "FAKE_NPX_EXIT"];
  const saved = { PATH: process.env.PATH };
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env, { PATH: `${bin}:${process.env.PATH}` });
  try {
    return await transcribeWav({ wavRel: "a.wav", hyperframesDir: tmpdir() });
  } finally {
    process.env.PATH = saved.PATH;
    for (const k of keys) delete process.env[k];
  }
}

test("success returns the words", async () => {
  const words = [{ id: "w0", text: "hi", start: 0, end: 0.2 }];
  const r = await run({ FAKE_NPX_TRANSCRIPT: JSON.stringify(words) });
  assert.deepEqual(r, { words, error: null });
});

test("skipped JSON reports the reason and install hint", async () => {
  const r = await run({
    FAKE_NPX_EXIT: "1",
    FAKE_NPX_JSON: JSON.stringify({
      ok: false,
      skipped: true,
      reason: "whisper_unavailable",
      install: "brew install whisper-cpp",
    }),
  });
  assert.equal(r.words, null);
  assert.match(r.error, /whisper_unavailable/);
  assert.match(r.error, /brew install whisper-cpp/);
});

test("failure JSON with an error message is reported", async () => {
  const r = await run({ FAKE_NPX_EXIT: "1", FAKE_NPX_JSON: '{"ok":false,"error":"bad audio"}' });
  assert.match(r.error, /bad audio/);
});

test("non-zero exit without JSON reports status and stderr tail", async () => {
  const r = await run({ FAKE_NPX_EXIT: "3", FAKE_NPX_STDERR: "boom happened" });
  assert.equal(r.words, null);
  assert.match(r.error, /exit 3/);
  assert.match(r.error, /boom happened/);
});

test("zero exit with an empty transcript is an error", async () => {
  const r = await run({ FAKE_NPX_TRANSCRIPT: "[]" });
  assert.deepEqual(r, { words: null, error: "no words in transcript.json" });
});
