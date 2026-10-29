import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);

test("passive chat errors immediately redraw only the inferred window, share the signal and never fetch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-model-limit-"));
  try {
    await run(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const { createClaudeUsageStatus } = await import(${JSON.stringify(new URL("../lib/status.ts", import.meta.url).href)});
      const { formatClaudeUsageStatusline } = await import(${JSON.stringify(new URL("../lib/status-format.ts", import.meta.url).href)});
      const { claudeUsageTelegramStatusLine } = await import(${JSON.stringify(new URL("../lib/telegram.ts", import.meta.url).href)});
      const now = 2_000_000_000_000;
      Date.now = () => now;
      let fetches = 0;
      globalThis.fetch = async () => { fetches++; throw new Error("Unexpected quota request"); };
      const stateDir = join(process.env.PI_CODING_AGENT_DIR, "tmp", "pi-claude-usage");
      mkdirSync(stateDir, { recursive: true });
      const path = join(stateDir, "usage.json");
      const model = { provider: "anthropic", id: "claude-opus-4-6", name: "Opus", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" };
      writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: { anthropic: { modelOverrides: { [model.id]: { speed: "fast" } } } } }));
      const message = { role: "assistant", provider: model.provider, api: model.api, model: model.id, stopReason: "error", errorMessage: '429 ' + JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "This request would exceed your account's rate limit. Please try again later." } }) };
      const read = () => JSON.parse(readFileSync(path, "utf8"));
      const instance = () => {
        const handlers = new Map();
        let status;
        let oauth = true;
        const ctx = {
          model,
          modelRegistry: { find: () => ctx.model, isUsingOAuth: () => oauth },
          ui: { setStatus: (_, value) => { status = value; }, theme: { fg: (_, value) => value, bg: (role, value) => '[' + role + ':' + value + ']' } },
        };
        createClaudeUsageStatus({ on: (name, handler) => handlers.set(name, handler) });
        return { ctx, status: () => status, oauth: value => { oauth = value; }, emit: (name, event = {}) => handlers.get(name)?.(event, ctx) };
      };
      const window = usedPercent => ({ usedPercent, resetAt: now + 9_000_000 });
      for (const [report, expected] of [
        [{ primary: window(97), secondary: window(17) }, { primary: window(100), secondary: window(17) }],
        [{ primary: window(20), secondary: window(98) }, { primary: window(20), secondary: window(100) }],
        [{ primary: window(97), secondary: window(98) }, { primary: window(100), secondary: window(98) }],
        [{ primary: window(96), secondary: window(99.5) }, { primary: window(96), secondary: window(100) }],
        [{ primary: window(97), secondary: window(99.5) }, { primary: window(100), secondary: window(99.5) }],
        [{ secondary: window(98) }, { secondary: window(100) }],
      ]) {
        const state = { owner: "leader", claimId: "generation", claimedAt: now, updatedAt: now - 1, report, error: "429", failures: 2, retryNotBefore: now + 600_000 };
        writeFileSync(path, JSON.stringify(state));
        const leader = instance();
        const follower = instance();
        try {
          leader.emit("session_start");
          follower.emit("session_start");
          leader.emit("message_end", { message });
          assert.equal(leader.status(), formatClaudeUsageStatusline(expected, leader.ctx) + " fast");
          assert.deepEqual(read(), { ...state, modelRateLimitedAt: now });
          follower.emit("session_tree");
          assert.equal(follower.status(), leader.status());
          assert.equal(claudeUsageTelegramStatusLine(expected, model).value.endsWith(" fast"), true);
          // A later authoritative snapshot clears the inferred zero without changing cadence.
          const recovered = { ...state, updatedAt: now + 1, report: { primary: window(10), secondary: window(17) } };
          writeFileSync(path, JSON.stringify(recovered));
          leader.emit("session_tree");
          await new Promise(resolve => setTimeout(resolve, 180));
          assert.equal(leader.status(), formatClaudeUsageStatusline(recovered.report, leader.ctx) + " fast");
        } finally {
          leader.emit("session_shutdown");
          follower.emit("session_shutdown");
        }
      }
      for (const gate of ["api-key", "proxy", "other-provider", "other-message", "generic-error", "healthy", "boundary", "primary-exhausted", "weekly-exhausted"]) {
        const report = { primary: window(gate === "healthy" ? 92 : gate === "boundary" ? 95 : gate === "primary-exhausted" ? 100 : 97), secondary: window(gate === "weekly-exhausted" ? 100 : gate === "primary-exhausted" ? 98 : 17) };
        const state = { owner: "leader", claimedAt: now, updatedAt: now, report };
        writeFileSync(path, JSON.stringify(state));
        const viewer = instance();
        if (gate === "api-key") viewer.oauth(false);
        if (gate === "proxy") viewer.ctx.model = { ...model, baseUrl: "https://proxy.example" };
        if (gate === "other-provider") viewer.ctx.model = { ...model, provider: "proxy" };
        try {
          viewer.emit("session_start");
          const before = viewer.status();
          const observed = gate === "other-message" ? { ...message, role: "user" } : gate === "generic-error" ? { ...message, errorMessage: "429 Too Many Requests" } : message;
          viewer.emit("message_end", { message: observed });
          assert.deepEqual(read(), state, gate);
          assert.equal(viewer.status(), before, gate);
        } finally { viewer.emit("session_shutdown"); }
      }
      assert.equal(fetches, 0);
    `], { env: { ...process.env, PI_CODING_AGENT_DIR: dir }, timeout: 15_000 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
