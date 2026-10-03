import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
test("Telegram renders current-model Fast and ignores unsupported Claude overrides", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-telegram-fast-"));
  try {
    await run(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      const { claudeUsageTelegramStatusLine: row } = await import(${JSON.stringify(new URL("../lib/telegram.ts", import.meta.url).href)});
      const model = { provider: "anthropic", id: "claude-opus-4-6", name: "Opus" };
      const report = { secondary: { usedPercent: 25 } };
      const path = join(process.env.PI_CODING_AGENT_DIR, "models.json");
      const set = enabled => writeFileSync(path, JSON.stringify({ providers: { anthropic: { modelOverrides: { "claude-opus-4-6": enabled ? { speed: "fast" } : {}, "claude-sonnet-4-6": { speed: "fast" } } } } }));
      set(false);
      const plain = row(report, model);
      assert.ok(plain);
      assert.equal(row(undefined, model), undefined);
      set(true);
      assert.deepEqual(row(report, model), { ...plain, value: plain.value + " fast" });
      assert.deepEqual(row(undefined, model), { label: "claude", value: "fast" });
      assert.deepEqual(row(report, { ...model, id: "claude-sonnet-4-6" }), plain);
      assert.equal(row(undefined, { ...model, id: "claude-sonnet-4-6" }), undefined);
      assert.equal(row(report, { ...model, id: "claude-opus-other" }).value, plain.value);
      assert.equal(row(report, { ...model, provider: "openai-codex" }), undefined);
      assert.equal(row(report, undefined), undefined);
      set(false);
      assert.deepEqual(row(report, model), plain);
      writeFileSync(path, "invalid json");
      assert.deepEqual(row(report, model), plain);
    `], { env: { ...process.env, PI_CODING_AGENT_DIR: dir }, timeout: 15_000 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
