import assert from "node:assert/strict";
import test from "node:test";
import { queryUsage } from "../lib/query.ts";

const model = { id: "current", name: "Current", provider: "anthropic" };
const fallback = { ...model, id: "fallback" };

function context(resolve: (candidate: typeof model) => Promise<object>) {
  return {
    model,
    modelRegistry: {
      getAvailable: () => [model, { ...model, provider: "other" }, fallback],
      getAll: () => [fallback],
      getApiKeyAndHeaders: resolve,
    },
  } as never;
}

test("query selects Pi subscription OAuth candidates once and sends only usage auth headers", async () => {
  const previous = globalThis.fetch;
  const candidates: string[] = [];
  let requests = 0;
  globalThis.fetch = async (url, init) => {
    requests++;
    assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
    assert.deepEqual(init?.headers, {
      Authorization: "Bearer sk-ant-oat-fixture",
      "anthropic-beta": "oauth-2025-04-20",
      Accept: "application/json",
      "User-Agent": "pi-claude-usage",
    });
    return new Response(JSON.stringify({ seven_day: { utilization: 35 } }));
  };
  try {
    const ctx = context(async candidate => {
      candidates.push(candidate.id);
      return { ok: true, apiKey: candidate.id === "current" ? "sk-ant-api-fixture" : "sk-ant-oat-fixture" };
    });
    assert.deepEqual(await queryUsage(ctx, 1000, () => true), {
      ok: true, report: { secondary: { usedPercent: 35 } },
    });
    assert.deepEqual(candidates, ["current", "fallback"]);
    assert.equal(requests, 1);
  } finally { globalThis.fetch = previous; }
});

test("query denies network admission before auth and again after asynchronous auth", async () => {
  const previous = globalThis.fetch;
  let authCalls = 0;
  let allowed = false;
  globalThis.fetch = async () => { throw new Error("Network admission was denied"); };
  const ctx = context(async () => {
    authCalls++;
    allowed = false;
    return { ok: true, apiKey: "sk-ant-oat-fixture" };
  });
  try {
    assert.equal(await queryUsage(ctx, 1000, () => allowed), undefined);
    assert.equal(authCalls, 0);
    allowed = true;
    assert.equal(await queryUsage(ctx, 1000, () => allowed), undefined);
    assert.equal(authCalls, 1);
  } finally { globalThis.fetch = previous; }
});

test("query preserves rate-limit metadata while redacting body credentials", async () => {
  const previous = globalThis.fetch;
  const ctx = context(async () => ({ ok: true, apiKey: "sk-ant-oat-fixture" }));
  try {
    for (const [header, expected] of [["3.5", 3500], ["Infinity", undefined], ["", undefined]] as const) {
      globalThis.fetch = async () => new Response(
        'Bearer private-token sk-ant-oat-private {"access_token":"private-access"}',
        { status: 429, statusText: "Too Many Requests", headers: { "retry-after": header } },
      );
      const result = await queryUsage(ctx, 1000, () => true);
      assert.ok(result && !result.ok);
      assert.equal(result.rateLimited, true);
      assert.equal(result.retryAfterMs, expected);
      assert.match(result.message, /returned 429/);
      assert.doesNotMatch(result.message, /private-token|sk-ant-oat-private|private-access/);
    }
  } finally { globalThis.fetch = previous; }
});

test("query reports malformed transport JSON through the domain response parser", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response("not-json");
  try {
    const result = await queryUsage(context(async () => ({ ok: true, apiKey: "sk-ant-oat-fixture" })), 1000, () => true);
    assert.ok(result && !result.ok);
    assert.match(result.message, /Claude usage endpoint response was not valid JSON/);
    assert.equal(result.rateLimited, false);
  } finally { globalThis.fetch = previous; }
});
