import assert from "node:assert/strict";
import test from "node:test";

import {
  formatClaudeUsageBar,
  formatClaudeUsageLoadingBar,
  formatClaudeUsageStatusValue,
  formatClaudeUsageStatusline,
  formatResetCountdown,
  formatWeeklyResetCountdown,
  isStaleExtensionContextError,
  isUsageUnavailable,
  nextResetCountdownDelayForRemainingMs,
  nextResetCountdownDelayMs,
  normalizeUsagePayload,
} from "../index.ts";

const secondMs = 1000;
const minuteMs = 60 * secondMs;
const hourMs = 60 * minuteMs;
const hourTenthMs = 6 * minuteMs;
const dayMs = 24 * hourMs;
const dayTenthMs = 144 * minuteMs;

const testCtx = {
  ui: {
    theme: {
      fg: (name: string, value: string) => `<fg:${name}>${value}</fg>`,
      bg: (name: string, value: string) => `<bg:${name}>${value}</bg>`,
    },
  },
} as never;

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

test("formats the dual quota bar with 20 steps per window", () => {
  assert.equal(
    formatClaudeUsageBar({
      primary: { usedPercent: 0 },
      secondary: { usedPercent: 0 },
    }),
    "██████████",
  );
  assert.equal(
    formatClaudeUsageBar({
      primary: { usedPercent: 50 },
      secondary: { usedPercent: 100 },
    }),
    "▀▀▀▀▀⠀⠀⠀⠀⠀",
  );
  assert.equal(formatClaudeUsageBar({}), undefined);
});

test("keeps positive remaining quota visible at the empty edge", () => {
  assert.equal(
    formatClaudeUsageBar({
      primary: { usedPercent: 99.9 },
      secondary: { usedPercent: 100 },
    }),
    "▘⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  );
  assert.equal(
    formatClaudeUsageBar({
      primary: { usedPercent: 100 },
      secondary: { usedPercent: 100 },
    }),
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  );
});

test("formats a single window as remaining percentage and reset", () => {
  const report = { secondary: { usedPercent: 33, resetAt: now + 7 * dayMs } };

  assert.equal(formatClaudeUsageStatusValue(report, now), "67% 7d");
  assert.equal(
    formatClaudeUsageStatusline({ secondary: { usedPercent: 50 } }, testCtx),
    "<fg:accent>claude</fg> <fg:dim>50%</fg>",
  );
  assert.equal(formatWeeklyResetCountdown(report, now), "7d");
  assert.equal(nextResetCountdownDelayMs(report, now), dayTenthMs);
});

test("formats counter-moving loading markers for both quota windows", () => {
  assert.equal(formatClaudeUsageLoadingBar(0), "▘⠀⠀⠀⠀⠀⠀⠀⠀▗");
  assert.equal(formatClaudeUsageLoadingBar(1), "▝⠀⠀⠀⠀⠀⠀⠀⠀▖");
  assert.equal(formatClaudeUsageLoadingBar(9), "⠀⠀⠀⠀▝▖⠀⠀⠀⠀");
  assert.equal(formatClaudeUsageLoadingBar(38), "▘⠀⠀⠀⠀⠀⠀⠀⠀▗");
  assert.equal(formatClaudeUsageLoadingBar(Number.NaN), "▘⠀⠀⠀⠀⠀⠀⠀⠀▗");
});

test("formats weekly reset countdown by remaining duration bucket", () => {
  assert.equal(formatResetCountdown(now + 7 * dayMs, now), "7d");
  assert.equal(
    formatResetCountdown(
      now + 6 * dayMs + 23 * hourMs + 59 * minuteMs + 1,
      now,
    ),
    "7d",
  );
  assert.equal(
    formatResetCountdown(now + 6 * dayMs + 21 * hourMs + 36 * minuteMs, now),
    "6.9d",
  );
  assert.equal(
    formatResetCountdown(now + 6 * dayMs + 14 * hourMs + 24 * minuteMs, now),
    "6.6d",
  );
  assert.equal(
    formatResetCountdown(now + 5 * dayMs + 2 * hourMs + 24 * minuteMs, now),
    "5.1d",
  );
  assert.equal(formatResetCountdown(now + 5 * dayMs, now), "5d");
  assert.equal(
    formatResetCountdown(now + dayMs + 2 * hourMs + 24 * minuteMs, now),
    "1.1d",
  );
  assert.equal(formatResetCountdown(now + dayMs, now), "24h");
  assert.equal(
    formatResetCountdown(now + 23 * hourMs + 59 * minuteMs, now),
    "24h",
  );
  assert.equal(
    formatResetCountdown(now + 23 * hourMs + 42 * minuteMs, now),
    "23.7h",
  );
  assert.equal(
    formatResetCountdown(now + 20 * hourMs + 6 * minuteMs, now),
    "20.1h",
  );
  assert.equal(formatResetCountdown(now + 20 * hourMs, now), "20h");
  assert.equal(
    formatResetCountdown(now + 19 * hourMs + 54 * minuteMs, now),
    "19.9h",
  );
  assert.equal(formatResetCountdown(now + hourMs + 24 * minuteMs, now), "1.4h");
  assert.equal(formatResetCountdown(now + hourMs + 18 * minuteMs, now), "1.3h");
  assert.equal(formatResetCountdown(now + hourMs + 12 * minuteMs, now), "1.2h");
  assert.equal(formatResetCountdown(now + hourMs + 6 * minuteMs, now), "1.1h");
  assert.equal(formatResetCountdown(now + hourMs, now), "1h");
  assert.equal(
    formatResetCountdown(now + 59 * minuteMs + 59 * secondMs, now),
    "59m",
  );
  assert.equal(formatResetCountdown(now + 59 * secondMs + 999, now), "59s");
  assert.equal(formatResetCountdown(now + 999, now), "0s");
  assert.equal(formatResetCountdown(now - secondMs, now), "0s");
});

test("schedules countdown redraws at the next display boundary", () => {
  assert.equal(nextResetCountdownDelayForRemainingMs(7 * dayMs), dayTenthMs);
  assert.equal(
    nextResetCountdownDelayForRemainingMs(6 * dayMs + 23 * hourMs),
    84 * minuteMs,
  );
  assert.equal(
    nextResetCountdownDelayForRemainingMs(23 * hourMs + 59 * minuteMs),
    5 * minuteMs,
  );
  assert.equal(
    nextResetCountdownDelayForRemainingMs(23 * hourMs + 15 * minuteMs),
    3 * minuteMs,
  );
  assert.equal(nextResetCountdownDelayForRemainingMs(20 * hourMs), hourTenthMs);
  assert.equal(nextResetCountdownDelayForRemainingMs(hourMs), 1);
  assert.equal(
    nextResetCountdownDelayForRemainingMs(59 * minuteMs + 30 * secondMs),
    30 * secondMs + 1,
  );
  assert.equal(nextResetCountdownDelayForRemainingMs(59 * secondMs + 250), 251);
  assert.equal(nextResetCountdownDelayForRemainingMs(0), undefined);
});

test("uses the subdued bar background while keeping the countdown outside it", () => {
  assert.equal(
    formatClaudeUsageStatusline(
      {
        primary: { usedPercent: 0 },
        secondary: { usedPercent: 0, resetAt: Date.now() + 6 * dayMs },
      },
      testCtx,
    ),
    "<fg:accent>claude</fg> <bg:userMessageBg><fg:dim>██████████</fg></bg> <fg:dim>6d</fg>",
  );
});

test("uses an error background when either quota window is exhausted", () => {
  assert.equal(
    formatClaudeUsageStatusline(
      {
        primary: { usedPercent: 100, resetAt: Date.now() + 5 * hourMs },
        secondary: { usedPercent: 50, resetAt: Date.now() + 7 * dayMs },
      },
      testCtx,
    ),
    "<fg:accent>claude</fg> <bg:toolErrorBg><fg:dim>▄▄▄▄▄⠀⠀⠀⠀⠀</fg></bg> <fg:dim>5h/7d</fg>",
  );
  assert.equal(
    formatClaudeUsageStatusline(
      {
        primary: { usedPercent: 50 },
        secondary: { usedPercent: 100, resetAt: Date.now() + 7 * dayMs },
      },
      testCtx,
    ),
    "<fg:accent>claude</fg> <bg:toolErrorBg><fg:dim>▀▀▀▀▀⠀⠀⠀⠀⠀</fg></bg> <fg:dim>7d</fg>",
  );
});

test("formats reusable compact status values", () => {
  assert.equal(
    formatClaudeUsageStatusValue(
      {
        primary: { usedPercent: 50 },
        secondary: { usedPercent: 100, resetAt: now + 23 * hourMs },
      },
      now,
    ),
    "▀▀▀▀▀⠀⠀⠀⠀⠀ 23h",
  );
});

test("formats exhausted primary windows with the full dual bar", () => {
  assert.equal(
    formatClaudeUsageStatusValue(
      {
        primary: { usedPercent: 100, resetAt: now + 5 * hourMs },
        secondary: { usedPercent: 50, resetAt: now + 7 * dayMs },
      },
      now,
    ),
    "▄▄▄▄▄⠀⠀⠀⠀⠀ 5h/7d",
  );
  assert.equal(
    formatClaudeUsageStatusValue(
      {
        primary: { usedPercent: 100 },
        secondary: { usedPercent: 50, resetAt: now + 7 * dayMs },
      },
      now,
    ),
    "▄▄▄▄▄⠀⠀⠀⠀⠀ 7d",
  );
});

test("schedules exhausted primary countdown redraws by the nearest reset label", () => {
  assert.equal(
    nextResetCountdownDelayMs(
      {
        primary: { usedPercent: 100, resetAt: now + 59 * secondMs + 250 },
        secondary: { usedPercent: 50, resetAt: now + 7 * dayMs },
      },
      now,
    ),
    251,
  );
});

test("formats weekly reset countdown from the secondary window", () => {
  assert.equal(
    formatWeeklyResetCountdown(
      {
        primary: { usedPercent: 10, resetAt: now + hourMs },
        secondary: { usedPercent: 50, resetAt: now + 3 * hourMs },
      },
      now,
    ),
    "3h",
  );
});

test("detects stale extension context errors", () => {
  assert.equal(
    isStaleExtensionContextError(
      new Error(
        "This extension ctx is stale after session replacement or reload.",
      ),
    ),
    true,
  );
  assert.equal(
    isStaleExtensionContextError(new Error("network failed")),
    false,
  );
  assert.equal(isStaleExtensionContextError("ctx is stale"), false);
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
