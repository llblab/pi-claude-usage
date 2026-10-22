/** Domain: status formatting. Owns: quota bars, labels, countdown boundaries and loading/problem text. Excludes: lifecycle, I/O and Fast state. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isUsageUnavailable, type ClaudeUsageReport, type NormalizedRateLimitWindow, type UsageQueryError } from "./usage.ts";

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const HOUR_TENTH_MS = 6 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const DAY_TENTH_MS = 144 * MINUTE_MS;
export const STATUS_LABEL_TEXT = "claude";
export const DUAL_BAR_WIDTH = 10;
const DUAL_BAR_CHARS = [
  "⠀",
  "▘",
  "▝",
  "▀",
  "▖",
  "▌",
  "▞",
  "▛",
  "▗",
  "▚",
  "▐",
  "▜",
  "▄",
  "▙",
  "▟",
  "█",
];

export function formatClaudeUsageStatusline(
  report: ClaudeUsageReport,
  ctx: ExtensionContext,
): string {
  const value = formatClaudeUsageStatusValue(report);
  if (!value) return formatStatuslineText(ctx, "n/a");
  if (!report.primary || !report.secondary)
    return formatStatuslineText(ctx, value);
  const [bar, countdown] = value.split(" ", 2);
  const barText = formatStatuslineBarText(
    ctx,
    bar ?? "",
    hasExhaustedQuotaWindow(report) ? "toolErrorBg" : "userMessageBg",
  );
  return countdown
    ? `${barText} ${ctx.ui.theme.fg("dim", countdown)}`
    : barText;
}

export function formatClaudeUsageBar(
  report: ClaudeUsageReport,
): string | undefined {
  if (!report.primary && !report.secondary) return undefined;
  return formatAdaptiveLimitBar(report.primary, report.secondary);
}

export function formatClaudeUsageStatusValue(
  report: ClaudeUsageReport,
  now = Date.now(),
): string | undefined {
  if (!report.primary || !report.secondary) {
    const window = report.primary ?? report.secondary;
    if (!window) return undefined;
    const percentage = `${Math.round(remainingPercent(window))}%`;
    const countdown = window.resetAt
      ? formatResetCountdown(window.resetAt, now)
      : undefined;
    return countdown ? `${percentage} ${countdown}` : percentage;
  }
  const bar = formatDualLimitBar(report.primary, report.secondary);
  if (isQuotaWindowExhausted(report.primary) && report.primary.resetAt) {
    const primaryCountdown = formatResetCountdown(report.primary.resetAt, now);
    const weeklyCountdown = report.secondary.resetAt
      ? formatResetCountdown(report.secondary.resetAt, now)
      : undefined;
    return weeklyCountdown
      ? `${bar} ${primaryCountdown}/${weeklyCountdown}`
      : `${bar} ${primaryCountdown}`;
  }
  const countdown = formatWeeklyResetCountdown(report, now);
  return countdown ? `${bar} ${countdown}` : bar;
}

export function formatWeeklyResetCountdown(
  report: ClaudeUsageReport,
  now = Date.now(),
): string | undefined {
  const resetAt = weeklyWindow(report)?.resetAt;
  if (resetAt === undefined) return undefined;
  return formatResetCountdown(resetAt, now);
}

export function formatResetCountdown(
  resetAt: number,
  now = Date.now(),
): string {
  const remainingMs = Math.max(0, resetAt - now);
  if (remainingMs > DAY_MS) {
    const dayTenths = Math.max(10, Math.ceil(remainingMs / DAY_TENTH_MS));
    return `${formatTenths(dayTenths)}d`;
  }
  if (remainingMs >= HOUR_MS) {
    const hourTenths = Math.max(10, Math.ceil(remainingMs / HOUR_TENTH_MS));
    return `${formatTenths(hourTenths)}h`;
  }
  if (remainingMs >= MINUTE_MS)
    return `${Math.floor(remainingMs / MINUTE_MS)}m`;
  return `${Math.floor(remainingMs / SECOND_MS)}s`;
}


export function nextResetCountdownDelayMs(
  report: ClaudeUsageReport,
  now = Date.now(),
): number | undefined {
  const resetTimes = [weeklyWindow(report)?.resetAt];
  if (report.secondary && isQuotaWindowExhausted(report.primary)) {
    resetTimes.push(report.primary?.resetAt);
  }
  const delays = resetTimes
    .filter((resetAt): resetAt is number => resetAt !== undefined)
    .map((resetAt) => nextResetCountdownDelayForRemainingMs(resetAt - now))
    .filter((delay): delay is number => delay !== undefined);
  return delays.length > 0 ? Math.min(...delays) : undefined;
}

export function nextResetCountdownDelayForRemainingMs(
  remainingMs: number,
): number | undefined {
  if (remainingMs <= 0) return undefined;
  if (remainingMs > DAY_MS) {
    const dayTenths = Math.max(10, Math.ceil(remainingMs / DAY_TENTH_MS));
    return Math.max(1, remainingMs - (dayTenths - 1) * DAY_TENTH_MS);
  }
  if (remainingMs >= HOUR_MS) {
    const hourTenths = Math.max(10, Math.ceil(remainingMs / HOUR_TENTH_MS));
    if (hourTenths === 10) return Math.max(1, remainingMs - HOUR_MS + 1);
    return Math.max(1, remainingMs - (hourTenths - 1) * HOUR_TENTH_MS);
  }
  if (remainingMs >= MINUTE_MS) {
    return Math.max(
      1,
      remainingMs - Math.floor(remainingMs / MINUTE_MS) * MINUTE_MS + 1,
    );
  }
  return Math.max(
    1,
    remainingMs - Math.floor(remainingMs / SECOND_MS) * SECOND_MS + 1,
  );
}

function formatTenths(value: number): string {
  return value % 10 === 0 ? String(value / 10) : (value / 10).toFixed(1);
}

function formatStatuslineText(
  ctx: ExtensionContext,
  value: string,
): string {
  const label = ctx.ui.theme.fg("accent", STATUS_LABEL_TEXT);
  return `${label} ${ctx.ui.theme.fg("dim", value)}`;
}

function formatStatuslineBarText(
  ctx: ExtensionContext,
  bar: string,
  background: "userMessageBg" | "toolErrorBg",
): string {
  const label = ctx.ui.theme.fg("accent", STATUS_LABEL_TEXT);
  const value = ctx.ui.theme.bg(background, ctx.ui.theme.fg("dim", bar));
  return `${label} ${value}`;
}

export function formatClaudeUsageLoadingBar(frame: number): string {
  const totalParts = DUAL_BAR_WIDTH * 2;
  const cycleFrames = (totalParts - 1) * 2;
  const finiteFrame = Number.isFinite(frame) ? frame : 0;
  const cycleFrame = Math.abs(Math.trunc(finiteFrame)) % cycleFrames;
  const primaryPart =
    cycleFrame < totalParts ? cycleFrame : cycleFrames - cycleFrame;
  const secondaryPart = totalParts - primaryPart - 1;
  const masks = Array<number>(DUAL_BAR_WIDTH).fill(0);
  const primaryCell = Math.floor(primaryPart / 2);
  const secondaryCell = Math.floor(secondaryPart / 2);
  masks[primaryCell] |= primaryPart % 2 === 0 ? 1 : 2;
  masks[secondaryCell] |= secondaryPart % 2 === 0 ? 4 : 8;
  return masks.map((mask) => DUAL_BAR_CHARS[mask]).join("");
}

export function formatStatuslineLoading(
  ctx: ExtensionContext,
  frame: number,
): string {
  return formatStatuslineBarText(
    ctx,
    formatClaudeUsageLoadingBar(frame),
    "userMessageBg",
  );
}

export function formatStatuslineProblem(
  ctx: ExtensionContext,
  errors: UsageQueryError[],
): string {
  const label = ctx.ui.theme.fg("accent", STATUS_LABEL_TEXT);
  const value = isUsageUnavailable(errors)
    ? ctx.ui.theme.fg("muted", "n/a")
    : ctx.ui.theme.fg("error", "error");
  return `${label} ${value}`;
}
function formatAdaptiveLimitBar(
  primary: NormalizedRateLimitWindow | undefined,
  secondary: NormalizedRateLimitWindow | undefined,
): string {
  if (!primary || !secondary) return formatSingleLimitBar(primary ?? secondary);
  return formatDualLimitBar(primary, secondary);
}

function formatSingleLimitBar(
  window: NormalizedRateLimitWindow | undefined,
): string {
  const filled = filledParts(window, DUAL_BAR_WIDTH * 4);
  const partMasks = [1, 4, 2, 8];
  let value = "";
  for (let index = 0; index < DUAL_BAR_WIDTH; index++) {
    const cellParts = Math.min(4, Math.max(0, filled - index * 4));
    let mask = 0;
    for (let part = 0; part < cellParts; part++) mask |= partMasks[part] ?? 0;
    value += DUAL_BAR_CHARS[mask];
  }
  return value;
}

function formatDualLimitBar(
  primary: NormalizedRateLimitWindow,
  secondary: NormalizedRateLimitWindow,
): string {
  const primaryParts = filledTwentieths(primary);
  const secondaryParts = filledTwentieths(secondary);
  let value = "";
  for (let index = 0; index < DUAL_BAR_WIDTH; index++) {
    const leftPart = index * 2 + 1;
    const rightPart = leftPart + 1;
    let mask = 0;
    if (primaryParts >= leftPart) mask |= 1;
    if (primaryParts >= rightPart) mask |= 2;
    if (secondaryParts >= leftPart) mask |= 4;
    if (secondaryParts >= rightPart) mask |= 8;
    value += DUAL_BAR_CHARS[mask];
  }
  return value;
}

function filledTwentieths(
  window: NormalizedRateLimitWindow | undefined,
): number {
  return filledParts(window, 20);
}

function filledParts(
  window: NormalizedRateLimitWindow | undefined,
  totalParts: number,
): number {
  if (!window || isQuotaWindowExhausted(window)) return 0;
  const remaining = remainingPercent(window);
  return Math.max(1, Math.round(remaining / (100 / totalParts)));
}

function remainingPercent(window: NormalizedRateLimitWindow): number {
  return 100 - clampPercent(window.usedPercent);
}

function isQuotaWindowExhausted(
  window: NormalizedRateLimitWindow | undefined,
): boolean {
  return window !== undefined && Math.round(remainingPercent(window)) === 0;
}

function hasExhaustedQuotaWindow(report: ClaudeUsageReport): boolean {
  return (
    isQuotaWindowExhausted(report.primary) ||
    isQuotaWindowExhausted(report.secondary)
  );
}

function weeklyWindow(
  report: ClaudeUsageReport,
): NormalizedRateLimitWindow | undefined {
  return report.secondary ?? report.primary;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
