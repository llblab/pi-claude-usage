import assert from "node:assert/strict";
import type { ExtensionContext, MessageEndEvent } from "@earendil-works/pi-coding-agent";
import test from "node:test";
import { applyModelRateLimit, isSubscriptionRateLimit } from "../lib/model-limit.ts";

const text = "This request would exceed your account's rate limit. Please try again later.";
const body = { type: "error", error: { type: "rate_limit_error", message: text } };
const model = {
  provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-4-6",
  baseUrl: "https://api.anthropic.com",
} as NonNullable<ExtensionContext["model"]>;
const message = {
  role: "assistant", provider: model.provider, api: model.api, model: model.id,
  stopReason: "error", errorMessage: `429 ${JSON.stringify(body)}`,
} as MessageEndEvent["message"];

test("recognizes only the structured account-limit error from native subscription models", () => {
  assert.equal(isSubscriptionRateLimit(message, model, true), true);
  assert.equal(isSubscriptionRateLimit(message, { ...model, baseUrl: model.baseUrl + "/" }, true), true);
  const wrapped = { ...body, request_id: "req_fixture", error: { ...body.error, message: text.replace(" your", "\n your") } };
  assert.equal(isSubscriptionRateLimit({ ...message, errorMessage: `Error: 429 ${JSON.stringify(wrapped, null, 2)}` } as never, model, true), true);
  assert.equal(isSubscriptionRateLimit(message, model, false), false);
  assert.equal(isSubscriptionRateLimit(message, undefined, true), false);
  for (const change of [
    { provider: "proxy" }, { api: "openai-completions" }, { id: "not-claude" },
    { baseUrl: "https://proxy.example" }, { baseUrl: "https://api.anthropic.com.attacker.example" },
    { baseUrl: "http://api.anthropic.com" }, { baseUrl: "https://api.anthropic.com/proxy" },
  ]) assert.equal(isSubscriptionRateLimit(message, { ...model, ...change } as never, true), false, JSON.stringify(change));
  for (const change of [
    { role: "user" }, { provider: "proxy" }, { api: "openai-completions" },
    { model: "claude-opus-other" }, { stopReason: "stop" }, { stopReason: "aborted" },
  ]) assert.equal(isSubscriptionRateLimit({ ...message, ...change } as never, model, true), false, JSON.stringify(change));
});

test("rejects generic throttling, billing, transport failures and unstructured lookalikes", () => {
  for (const errorMessage of [
    undefined, "429 Too Many Requests", `500 ${JSON.stringify(body)}`, "429 {not json}",
    `Claude usage endpoint returned 429 Too Many Requests: ${JSON.stringify(body)}`,
    `429 ${JSON.stringify({ ...body, type: "message" })}`,
    `429 ${JSON.stringify({ ...body, error: { ...body.error, type: "credits_required" } })}`,
    `429 ${JSON.stringify({ ...body, error: { ...body.error, message: "Rate limited. Please try again later." } })}`,
    `429 ${JSON.stringify({ ...body, error: { ...body.error, message: "org_level_disabled" } })}`,
    "429 null", "429 []", `429 ${JSON.stringify({ type: "error" })}`,
    `429 ${JSON.stringify({ ...body, error: { ...body.error, message: 123 } })}`,
  ]) assert.equal(isSubscriptionRateLimit({ ...message, errorMessage } as never, model, true), false, String(errorMessage));
});

test("inference changes at most one near-empty window, preserving measurements and known exhaustion", () => {
  for (const primaryUsed of [0, 92, 95, 95.001, 97, 99.5, 100, 101]) {
    for (const secondaryUsed of [17, 95, 95.001, 99, 100, 101]) {
      const report = {
        primary: { usedPercent: primaryUsed, resetAt: 123 },
        secondary: { usedPercent: secondaryUsed, resetAt: 456 },
      };
      const snapshot = structuredClone(report);
      const inferred = applyModelRateLimit(report);
      const primaryChanged = inferred.primary !== report.primary;
      const secondaryChanged = inferred.secondary !== report.secondary;
      const expectedChange = primaryUsed < 100 && secondaryUsed < 100 && (primaryUsed > 95 || secondaryUsed > 95);
      assert.equal(Number(primaryChanged) + Number(secondaryChanged), expectedChange ? 1 : 0);
      if (primaryChanged) assert.ok(primaryUsed > 95 && primaryUsed < 100);
      if (secondaryChanged) assert.ok(secondaryUsed > 95 && secondaryUsed < 100);
      assert.equal(inferred.primary?.usedPercent, primaryChanged ? 100 : primaryUsed);
      assert.equal(inferred.secondary?.usedPercent, secondaryChanged ? 100 : secondaryUsed);
      assert.equal(inferred.primary?.resetAt, 123);
      assert.equal(inferred.secondary?.resetAt, 456);
      assert.deepEqual(report, snapshot);
      assert.strictEqual(applyModelRateLimit(inferred), inferred);
      if (!expectedChange) assert.strictEqual(inferred, report);
    }
  }
  assert.deepEqual(applyModelRateLimit({ secondary: { usedPercent: 97 } }), { secondary: { usedPercent: 100 } });
  assert.deepEqual(applyModelRateLimit({ primary: { usedPercent: 97 } }), { primary: { usedPercent: 100 } });
  assert.deepEqual(applyModelRateLimit({}), {});
});

test("ambiguous near-empty windows use the empirical 1:6 budget ratio and favor five-hour ties", () => {
  for (const [primaryRemaining, secondaryRemaining, selected] of [
    [1, 2, "primary"],
    [2, 1, "primary"],
    [4, 0.5, "secondary"],
    [3, 0.5, "primary"],
    [3.001, 0.5, "secondary"],
    [2.999, 0.5, "primary"],
    [5, 1, "secondary"],
    [1, 5, "primary"],
  ] as const) {
    const report = {
      primary: { usedPercent: 100 - primaryRemaining },
      secondary: { usedPercent: 100 - secondaryRemaining },
    };
    const inferred = applyModelRateLimit(report);
    assert.equal(inferred[selected]?.usedPercent, 100, JSON.stringify({ primaryRemaining, secondaryRemaining }));
    const preserved = selected === "primary" ? "secondary" : "primary";
    assert.strictEqual(inferred[preserved], report[preserved]);
  }
});
