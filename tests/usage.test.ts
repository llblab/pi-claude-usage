import assert from "node:assert/strict";
import test from "node:test";
import { normalizeUsagePayload, isUsageUnavailable } from "../lib/usage.ts";

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;
const now = Date.parse("2026-05-28T00:00:00.000Z");

test("normalizes five_hour and seven_day windows from the OAuth usage payload", () => {
  const report = normalizeUsagePayload({
    five_hour: { utilization: 33, resets_at: "2026-05-28T05:00:00.000000+00:00" },
    seven_day: { utilization: 89.5, resets_at: "2026-06-04T00:00:00+00:00" },
    seven_day_opus: null,
    extra_usage: { is_enabled: false },
  });

  assert.deepEqual(report, {
    primary: { usedPercent: 33, resetAt: now + 5 * hourMs },
    secondary: { usedPercent: 89.5, resetAt: now + 7 * dayMs },
  });
});

test("keeps an idle five_hour window without a reset time", () => {
  assert.deepEqual(
    normalizeUsagePayload({
      five_hour: { utilization: 0, resets_at: null },
      seven_day: { utilization: 10, resets_at: "2026-06-04T00:00:00Z" },
    }),
    {
      primary: { usedPercent: 0 },
      secondary: { usedPercent: 10, resetAt: now + 7 * dayMs },
    },
  );
});

test("normalizes a payload with only the weekly window", () => {
  assert.deepEqual(
    normalizeUsagePayload({
      five_hour: null,
      seven_day: { utilization: 40, resets_at: null },
    }),
    { secondary: { usedPercent: 40 } },
  );
});

test("rejects payloads without displayable windows", () => {
  assert.throws(
    () => normalizeUsagePayload({ five_hour: null, seven_day: null }),
    /no displayable rate-limit windows/,
  );
  assert.throws(
    () => normalizeUsagePayload({ five_hour: { utilization: null } }),
    /no displayable rate-limit windows/,
  );
});

test("classifies n/a only when all query failures are unavailable states", () => {
  assert.equal(
    isUsageUnavailable([
      { message: "No Pi Anthropic subscription auth was available." },
    ]),
    true,
  );
  assert.equal(
    isUsageUnavailable([
      { message: "Claude usage endpoint returned 403 Forbidden: scope" },
    ]),
    true,
  );
  assert.equal(
    isUsageUnavailable([
      { message: "Claude usage endpoint returned 429 Too Many Requests" },
    ]),
    false,
  );
  assert.equal(isUsageUnavailable([]), false);
});
