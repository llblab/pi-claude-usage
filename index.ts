import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

const ANTHROPIC_PROVIDER_ID = "anthropic";
const CLAUDE_USAGE_EXTENSION_ID = "@llblab/pi-claude-usage";
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";
const DEFAULT_TIMEOUT_MS = 15_000;
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const HOUR_TENTH_MS = 6 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const DAY_TENTH_MS = 144 * MINUTE_MS;
/** How often an instance re-reads the shared file to redraw fresh data. */
const MAX_TICK_MS = 30 * SECOND_MS;
const MIN_TICK_MS = SECOND_MS;
const TAKEOVER_JITTER_MS = 2 * SECOND_MS;
/** A report older than this is no longer shown as current. */
const STALE_REPORT_MAX_AGE_MS = HOUR_MS;
const LOADING_FRAME_MS = 30;
const REDRAW_BLINK_MS = 150;
const STATUS_KEY = "aa-claude-usage";
const MAX_ERROR_BODY_CHARS = 600;
const STATUS_LABEL_TEXT = "claude";
const DUAL_BAR_WIDTH = 10;
const TELEGRAM_STATUS_IMPORT_SPECIFIERS = [
  "@llblab/pi-telegram/status",
  new URL("../pi-telegram/api/status.ts", import.meta.url).href,
];
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

type TimeoutHandle = ReturnType<typeof setTimeout> & { unref?: () => void };
type PiModel = NonNullable<ExtensionContext["model"]>;
type ClaudeUsageTelegramStatusModel = Pick<PiModel, "id" | "name" | "provider">;
type TelegramStatusLineProviderResult =
  { label: string; value: string } | undefined;
type TelegramStatusLineProvider = (ctx: {
  activeModel?: ClaudeUsageTelegramStatusModel;
}) => TelegramStatusLineProviderResult;
type TelegramStatusLineModule = {
  registerTelegramStatusLineProvider?: (
    provider: TelegramStatusLineProvider,
    options: { id: string },
  ) => () => void;
};

type QueryUsageResult =
  | { ok: true; report: ClaudeUsageReport }
  | {
      ok: false;
      message: string;
      rateLimited: boolean;
      retryAfterMs?: number;
    };

export type UsageQueryError = {
  message: string;
  cause?: unknown;
};

// --- Shared Refresh ---

/**
 * Cross-instance coordination for quota polling. Every Pi instance reads one
 * JSON file; a single "leader"
 * refreshes it every `LEADER_INTERVAL_MS`. Any other instance may take over once
 * the file is `TAKEOVER_AFTER_MS` old: it first claims leadership (owner and
 * timestamp) so nobody else is due, then fetches, then stamps the result. The
 * file is the only authority for requests and fenced publication. Writes are
 * atomic renames; short critical sections use an OS-backed SQLite mutex.
 */

export const LEADER_INTERVAL_MS = 60_000;
/** The leader is considered gone after missing its slot by 30 seconds. */
export const TAKEOVER_AFTER_MS = LEADER_INTERVAL_MS + 30_000;
/** Minimum pause between two fetch attempts of the same instance. */
export const MIN_ATTEMPT_GAP_MS = 60_000;

const STATE_FILE = "usage.json";
const LOCK_FILE = "mutex.sqlite";

/** `primary` is the 5-hour session window; `secondary` is the weekly window. */
export type ClaudeUsageReport = {
  primary?: NormalizedRateLimitWindow;
  secondary?: NormalizedRateLimitWindow;
};

export type NormalizedRateLimitWindow = {
  usedPercent: number;
  resetAt?: number;
};

export type SharedState = {
  report?: ClaudeUsageReport;
  /** When `report` was last fetched successfully. */
  updatedAt?: number;
  /**
   * When the leader last touched the file: written when it claims a refresh,
   * before fetching, and again when the fetch finishes.
   */
  claimedAt?: number;
  /** Instance id of the current leader (the last instance to claim). */
  owner?: string;
  /** Unique generation for this refresh, including renewals by the same owner. */
  claimId?: string;
  /** Last failure message; cleared by the next success. */
  error?: string;
  failures?: number;
  /** No instance should fetch before this time. */
  retryNotBefore?: number;
};

export function readState(dir: string): SharedState | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(join(dir, STATE_FILE), "utf8"),
    ) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as SharedState)
      : undefined;
  } catch {
    return undefined;
  }
}

export function writeState(dir: string, state: SharedState): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const temp = join(dir, `${STATE_FILE}.${process.pid}.tmp`);
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    renameSync(temp, join(dir, STATE_FILE));
    return true;
  } catch {
    return false;
  }
}

export type RefreshClaim = { owner: string; claimId: string };

export type RefreshOutcome =
  | { ok: true; report: ClaudeUsageReport }
  | {
      ok: false;
      error: string;
      rateLimited: boolean;
      retryAfterMs?: number;
    };

/** Read, decide and claim under the lock; never authorize an unwritten claim. */
export function claimRefresh(
  dir: string,
  owner: string,
  now?: number,
): RefreshClaim | undefined {
  const release = tryAcquireLock(dir);
  if (!release) return undefined;
  try {
    const current = readState(dir);
    const at = now ?? Date.now();
    if (!isRefreshDue(current, owner, at)) return undefined;
    const claim = { owner, claimId: randomUUID() };
    return writeState(dir, { ...current, ...claim, claimedAt: at })
      ? claim
      : undefined;
  } finally {
    release();
  }
}

function matchesClaim(
  state: SharedState | undefined,
  claim: RefreshClaim,
  now: number,
): boolean {
  return (
    state?.owner === claim.owner &&
    state.claimId === claim.claimId &&
    typeof state.claimedAt === "number" &&
    now - state.claimedAt < TAKEOVER_AFTER_MS
  );
}

/** Each admission check reads the file, not a remembered leadership flag. */
export function ownsRefreshClaim(
  dir: string,
  claim: RefreshClaim,
  now?: number,
): boolean {
  const current = readState(dir);
  return matchesClaim(current, claim, now ?? Date.now());
}

/** A late success OR failure must not overwrite a successor's state. */
export function publishRefresh(
  dir: string,
  claim: RefreshClaim,
  outcome: RefreshOutcome,
  now?: number,
): boolean {
  const release = tryAcquireLock(dir);
  if (!release) return false;
  try {
    const current = readState(dir);
    const at = now ?? Date.now();
    if (!matchesClaim(current, claim, at)) return false;
    if (outcome.ok) {
      return writeState(dir, {
        ...claim,
        claimedAt: at,
        updatedAt: at,
        report: outcome.report,
      });
    }
    const failures = (current?.failures ?? 0) + 1;
    return writeState(dir, {
      ...current,
      ...claim,
      claimedAt: at,
      error: outcome.error,
      failures,
      retryNotBefore: at + failureBackoffMs(failures, outcome),
    });
  } finally {
    release();
  }
}

/** Earliest time at which `owner` should try to refresh the state. */
export function nextRefreshAt(
  state: SharedState | undefined,
  owner: string,
  now: number,
): number {
  const hold = state?.retryNotBefore ?? 0;
  const touchedAt = Math.max(
    state?.updatedAt ?? -Infinity,
    state?.claimedAt ?? -Infinity,
  );
  if (touchedAt === -Infinity) return Math.max(now, hold);
  const interval =
    state?.owner === owner ? LEADER_INTERVAL_MS : TAKEOVER_AFTER_MS;
  return Math.max(touchedAt + interval, hold);
}

export function isRefreshDue(
  state: SharedState | undefined,
  owner: string,
  now: number,
): boolean {
  return nextRefreshAt(state, owner, now) <= now;
}

/** Exponential failure backoff; HTTP 429 gets a longer base and cap. */
export function failureBackoffMs(
  failures: number,
  options: { rateLimited: boolean; retryAfterMs?: number },
): number {
  const base = options.rateLimited ? 5 * 60_000 : 60_000;
  const cap = options.rateLimited ? 30 * 60_000 : 5 * 60_000;
  const exponential = Math.min(cap, base * 2 ** Math.max(0, failures - 1));
  return Math.max(options.retryAfterMs ?? 0, exponential);
}

/**
 * An empty SQLite transaction is a non-waiting, OS-backed mutex, not storage
 * for quota or leadership. Close or process death releases it; a paused live
 * holder cannot be evicted. Never unlink/replace mutex.sqlite while in use.
 */
export function tryAcquireLock(dir: string): (() => void) | undefined {
  let database: DatabaseSync | undefined;
  try {
    mkdirSync(dir, { recursive: true });
    database = new DatabaseSync(join(dir, LOCK_FILE));
    // Contention must not wait on Pi's TUI thread; PRAGMA also works on Node 22.
    database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
  } catch {
    database?.close();
    return undefined;
  }
  return () => {
    const held = database;
    database = undefined;
    held?.close();
  };
}

export default function claudeUsage(pi: ExtensionAPI) {
  const instanceId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const stateDir = join(getAgentDir(), "tmp", "pi-claude-usage");
  let lastAttemptAt = 0;
  let inFlightRefresh: Promise<void> | undefined;
  let shown: { key?: string; report?: ClaudeUsageReport; updatedAt?: number } = {};
  let statuslineBlinkTimer: TimeoutHandle | undefined;
  let statuslineCountdownTimer: TimeoutHandle | undefined;
  let statuslineLoadingTimer: TimeoutHandle | undefined;
  let statuslineRefreshTimer: TimeoutHandle | undefined;
  let statuslineLoadingFrame = 0;
  let statuslineRequestId = 0;
  let unregisterTelegramStatusLine: (() => void) | undefined;
  let telegramStatusLineRegistration: Promise<void> | undefined;

  const loadState = () => readState(stateDir);

  const ensureTelegramStatusLineRegistered = () => {
    if (unregisterTelegramStatusLine || telegramStatusLineRegistration) return;
    telegramStatusLineRegistration = registerClaudeUsageTelegramStatusLine(
      ({ activeModel }) => {
        if (!isAnthropicModel(activeModel)) return undefined;
        if (!shown.report) return undefined;
        const value = formatClaudeUsageStatusValue(shown.report);
        return value ? { label: STATUS_LABEL_TEXT, value } : undefined;
      },
    )
      .then((unregister) => {
        unregisterTelegramStatusLine = unregister;
      })
      .finally(() => {
        telegramStatusLineRegistration = undefined;
      });
  };

  const clearStatuslineTimers = () => {
    if (statuslineBlinkTimer) clearTimeout(statuslineBlinkTimer);
    if (statuslineCountdownTimer) clearTimeout(statuslineCountdownTimer);
    if (statuslineLoadingTimer) clearTimeout(statuslineLoadingTimer);
    if (statuslineRefreshTimer) clearTimeout(statuslineRefreshTimer);
    statuslineBlinkTimer = undefined;
    statuslineCountdownTimer = undefined;
    statuslineLoadingTimer = undefined;
    statuslineRefreshTimer = undefined;
  };

  const stopStatuslineLoading = () => {
    if (statuslineLoadingTimer) clearTimeout(statuslineLoadingTimer);
    statuslineLoadingTimer = undefined;
  };

  const startStatuslineLoading = (ctx: ExtensionContext) => {
    if (statuslineLoadingTimer) return;
    statuslineLoadingFrame = Math.random() < 0.5 ? 0 : DUAL_BAR_WIDTH * 2 - 1;
    const drawNextFrame = () => {
      try {
        ctx.ui.setStatus(
          STATUS_KEY,
          formatStatuslineLoading(ctx, statuslineLoadingFrame),
        );
        statuslineLoadingFrame += 1;
        statuslineLoadingTimer = setTimeout(
          drawNextFrame,
          LOADING_FRAME_MS,
        ) as TimeoutHandle;
        statuslineLoadingTimer.unref?.();
      } catch (error) {
        statuslineLoadingTimer = undefined;
        handleTimerError(error);
      }
    };
    drawNextFrame();
  };

  const clearUsageStatusline = (ctx: ExtensionContext) => {
    statuslineRequestId += 1;
    clearStatuslineTimers();
    shown = {};
    ctx.ui.setStatus(STATUS_KEY, undefined);
  };

  const scheduleStatuslineRefresh = (ctx: ExtensionContext, delayMs: number) => {
    if (statuslineRefreshTimer) clearTimeout(statuslineRefreshTimer);
    statuslineRefreshTimer = setTimeout(() => {
      void refreshCurrentClaudeUsageStatusline(ctx, false).catch(
        handleAsyncTimerError,
      );
    }, delayMs) as TimeoutHandle;
    statuslineRefreshTimer.unref?.();
  };

  const scheduleStatuslineCountdown = (
    ctx: ExtensionContext,
    report: ClaudeUsageReport,
  ) => {
    if (statuslineCountdownTimer) clearTimeout(statuslineCountdownTimer);
    const delayMs = nextResetCountdownDelayMs(report, Date.now());
    if (delayMs === undefined) {
      statuslineCountdownTimer = undefined;
      return;
    }
    statuslineCountdownTimer = setTimeout(() => {
      try {
        if (isAnthropicModel(ctx.model)) {
          ctx.ui.setStatus(STATUS_KEY, formatClaudeUsageStatusline(report, ctx));
          scheduleStatuslineCountdown(ctx, report);
        }
      } catch (error) {
        handleTimerError(error);
      }
    }, delayMs) as TimeoutHandle;
    statuslineCountdownTimer.unref?.();
  };

  const setUsageStatusline = (
    ctx: ExtensionContext,
    report: ClaudeUsageReport,
    blink: boolean,
  ) => {
    if (statuslineBlinkTimer) clearTimeout(statuslineBlinkTimer);
    if (statuslineCountdownTimer) clearTimeout(statuslineCountdownTimer);
    stopStatuslineLoading();
    statuslineBlinkTimer = undefined;
    statuslineCountdownTimer = undefined;
    const text = formatClaudeUsageStatusline(report, ctx);
    if (blink) {
      ctx.ui.setStatus(
        STATUS_KEY,
        formatStatuslineLoading(ctx, statuslineLoadingFrame),
      );
      statuslineBlinkTimer = setTimeout(() => {
        try {
          ctx.ui.setStatus(STATUS_KEY, text);
          scheduleStatuslineCountdown(ctx, report);
          statuslineBlinkTimer = undefined;
        } catch (error) {
          handleTimerError(error);
        }
      }, REDRAW_BLINK_MS) as TimeoutHandle;
      statuslineBlinkTimer.unref?.();
    } else {
      ctx.ui.setStatus(STATUS_KEY, text);
      scheduleStatuslineCountdown(ctx, report);
    }
  };

  /** Draws the shared state; skips redraws when nothing changed. */
  const renderState = (
    ctx: ExtensionContext,
    state: SharedState | undefined,
    force: boolean,
  ) => {
    // Cached display data is not permission to query when the file is unreadable.
    if (!state && shown.report && Date.now() - (shown.updatedAt ?? 0) < STALE_REPORT_MAX_AGE_MS) {
      if (force) setUsageStatusline(ctx, shown.report, false);
      return;
    }
    const usable =
      state?.report &&
      state.updatedAt !== undefined &&
      Date.now() - state.updatedAt < STALE_REPORT_MAX_AGE_MS
        ? state.report
        : undefined;
    if (usable) {
      const key = `report:${state?.updatedAt}`;
      if (!force && shown.key === key) return;
      const blink = shown.report
        ? formatClaudeUsageBar(shown.report) !== formatClaudeUsageBar(usable)
        : false;
      shown = { key, report: usable, updatedAt: state?.updatedAt };
      setUsageStatusline(ctx, usable, blink);
    } else if (state?.error) {
      const key = `error:${state.error}`;
      if (!force && shown.key === key) return;
      shown = { key };
      clearStatuslineTimers();
      ctx.ui.setStatus(
        STATUS_KEY,
        formatStatuslineProblem(ctx, [{ message: state.error }]),
      );
    } else {
      shown = { key: "loading" };
      startStatuslineLoading(ctx);
    }
  };

  /**
   * When this instance is due (leader after 1 minute, anyone after 90 seconds) it
   * claims leadership under the lock (owner and timestamp, so no other
   * instance is due), then fetches, then stamps the outcome. Failures are
   * published with a backoff so other instances do not pile on.
   */
  const refreshSharedState = (ctx: ExtensionContext) => {
    if (inFlightRefresh) return inFlightRefresh;
    const promise = (async () => {
      const claim = claimRefresh(stateDir, instanceId);
      if (!claim) return;
      lastAttemptAt = Date.now();
      const result = await queryUsage(
        ctx,
        DEFAULT_TIMEOUT_MS,
        () => ownsRefreshClaim(stateDir, claim),
      );
      if (!result) return;
      if (result.ok) {
        publishRefresh(stateDir, claim, result);
        return;
      }
      // A stale extension context is a local shutdown, not a server failure.
      if (result.message.includes("ctx is stale")) return;
      publishRefresh(stateDir, claim, {
        ok: false,
        error: result.message,
        rateLimited: result.rateLimited,
        retryAfterMs: result.retryAfterMs,
      });
    })().finally(() => {
      if (inFlightRefresh === promise) inFlightRefresh = undefined;
    });
    inFlightRefresh = promise;
    return promise;
  };

  const nextTickDelayMs = (state: SharedState | undefined) => {
    // Nothing to show yet (e.g. a claimed fetch is in flight): poll quickly.
    if (shown.key === "loading") return MIN_TICK_MS;
    const now = Date.now();
    const dueAt = Math.max(
      nextRefreshAt(state, instanceId, now),
      lastAttemptAt + MIN_ATTEMPT_GAP_MS,
    );
    const jitter =
      state?.owner === instanceId ? 0 : Math.random() * TAKEOVER_JITTER_MS;
    return Math.min(MAX_TICK_MS, Math.max(MIN_TICK_MS, dueAt - now + jitter));
  };

  const refreshCurrentClaudeUsageStatusline = async (
    ctx: ExtensionContext,
    forceRender: boolean,
    model?: ClaudeUsageTelegramStatusModel,
  ) => {
    try {
      if (!isAnthropicModel(model ?? ctx.model)) {
        clearUsageStatusline(ctx);
        return;
      }

      const requestId = statuslineRequestId + 1;
      statuslineRequestId = requestId;
      let state = loadState();
      renderState(ctx, state, forceRender);

      const now = Date.now();
      if (
        isRefreshDue(state, instanceId, now) &&
        now - lastAttemptAt >= MIN_ATTEMPT_GAP_MS
      ) {
        await refreshSharedState(ctx);
        if (requestId !== statuslineRequestId) return;
        if (!isAnthropicModel(ctx.model)) {
          clearUsageStatusline(ctx);
          return;
        }
        state = loadState();
        renderState(ctx, state, false);
      }
      scheduleStatuslineRefresh(ctx, nextTickDelayMs(state));
    } catch (error) {
      if (isStaleExtensionContextError(error)) {
        clearStatuslineTimers();
        return;
      }
      throw error;
    }
  };

  ensureTelegramStatusLineRegistered();

  pi.on("session_start", (_event, ctx) => {
    ensureTelegramStatusLineRegistered();
    if (isAnthropicModel(ctx.model))
      void refreshCurrentClaudeUsageStatusline(ctx, true).catch(
        handleAsyncTimerError,
      );
    else clearUsageStatusline(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    if (isAnthropicModel(ctx.model))
      void refreshCurrentClaudeUsageStatusline(ctx, true).catch(
        handleAsyncTimerError,
      );
    else clearUsageStatusline(ctx);
  });

  pi.on("model_select", (event, ctx) => {
    if (isAnthropicModel(event.model)) {
      void refreshCurrentClaudeUsageStatusline(ctx, true, event.model).catch(
        handleAsyncTimerError,
      );
    } else {
      clearUsageStatusline(ctx);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearUsageStatusline(ctx);
    unregisterTelegramStatusLine?.();
    unregisterTelegramStatusLine = undefined;
  });
}

function handleAsyncTimerError(error: unknown): void {
  handleTimerError(error);
}

function handleTimerError(error: unknown): void {
  if (isStaleExtensionContextError(error)) return;
  throw error;
}

export function isStaleExtensionContextError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("ctx is stale");
}

function isAnthropicModel(
  model: Pick<PiModel, "provider"> | undefined,
): boolean {
  return model?.provider === ANTHROPIC_PROVIDER_ID;
}

async function importTelegramStatusLineModule(): Promise<
  TelegramStatusLineModule | undefined
> {
  for (const specifier of TELEGRAM_STATUS_IMPORT_SPECIFIERS) {
    try {
      const imported = (await import(specifier)) as TelegramStatusLineModule;
      if (typeof imported.registerTelegramStatusLineProvider === "function") {
        return imported;
      }
    } catch {
      // pi-telegram is optional; absence just disables the Telegram status line.
    }
  }
  return undefined;
}

async function registerClaudeUsageTelegramStatusLine(
  provider: TelegramStatusLineProvider,
): Promise<(() => void) | undefined> {
  const telegramStatus = await importTelegramStatusLineModule();
  return telegramStatus?.registerTelegramStatusLineProvider?.(provider, {
    id: CLAUDE_USAGE_EXTENSION_ID,
  });
}

async function queryUsage(
  ctx: ExtensionContext,
  timeoutMs: number,
  mayQuery: () => boolean,
): Promise<QueryUsageResult | undefined> {
  try {
    if (!mayQuery()) return undefined;
    const auth = await resolvePiAnthropicAuth(ctx);
    if (!auth) {
      throw new Error(
        "No Pi Anthropic subscription auth was available. Use a Pi Anthropic model or run /login for Anthropic Claude Pro/Max.",
      );
    }

    if (!mayQuery()) return undefined;
    const response = await fetchWithTimeout(
      CLAUDE_USAGE_URL,
      { headers: auth.headers },
      timeoutMs,
    );
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        message: `Claude usage endpoint returned ${response.status} ${response.statusText}: ${redactErrorBody(text)}`,
        rateLimited: response.status === 429,
        retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
      };
    }

    const payload = parseJsonObject(text, "Claude usage endpoint response");
    return { ok: true, report: normalizeUsagePayload(payload) };
  } catch (cause) {
    return { ok: false, message: errorMessage(cause), rateLimited: false };
  }
}

function parseRetryAfterMs(value: string | null): number | undefined {
  const seconds = value === null ? undefined : asNumber(value);
  return seconds !== undefined && seconds > 0 ? seconds * SECOND_MS : undefined;
}

async function resolvePiAnthropicAuth(
  ctx: ExtensionContext,
): Promise<{ headers: Record<string, string> } | undefined> {
  const errors: string[] = [];

  for (const model of anthropicAuthCandidateModels(ctx)) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      errors.push(auth.error);
      continue;
    }
    // The usage endpoint only accepts subscription OAuth tokens, not API keys.
    if (auth.apiKey?.includes("sk-ant-oat")) {
      return {
        headers: {
          Authorization: `Bearer ${auth.apiKey}`,
          "anthropic-beta": ANTHROPIC_OAUTH_BETA,
          Accept: "application/json",
          "User-Agent": "pi-claude-usage",
        },
      };
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
  return undefined;
}

function anthropicAuthCandidateModels(ctx: ExtensionContext): PiModel[] {
  const candidates: PiModel[] = [];
  const seen = new Set<string>();
  const add = (model: PiModel | undefined) => {
    if (!model || model.provider !== ANTHROPIC_PROVIDER_ID) return;
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(model);
  };

  add(ctx.model);
  for (const model of ctx.modelRegistry.getAvailable()) add(model);
  for (const model of ctx.modelRegistry.getAll()) add(model);
  return candidates;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `Timed out after ${Math.round(timeoutMs / 1000)}s while fetching Claude usage.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Normalizes the `/api/oauth/usage` payload. `five_hour` maps to the primary
 * window and `seven_day` to the secondary one; `utilization` is a used percent.
 */
export function normalizeUsagePayload(
  payload: Record<string, unknown>,
): ClaudeUsageReport {
  const primary = normalizeUsageWindow(payload.five_hour);
  const secondary = normalizeUsageWindow(payload.seven_day);
  if (!primary && !secondary) {
    throw new Error(
      "Claude usage endpoint returned no displayable rate-limit windows.",
    );
  }
  const report: ClaudeUsageReport = {};
  if (primary) report.primary = primary;
  if (secondary) report.secondary = secondary;
  return report;
}

function normalizeUsageWindow(
  value: unknown,
): NormalizedRateLimitWindow | undefined {
  if (value === null || value === undefined) return undefined;
  const window = assertObject(value, "rate-limit window");
  const usedPercent = asNumber(window.utilization);
  if (usedPercent === undefined) return undefined;
  const resetAt = asResetTime(window.resets_at);
  return resetAt === undefined ? { usedPercent } : { usedPercent, resetAt };
}

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

function formatStatuslineLoading(
  ctx: ExtensionContext,
  frame: number,
): string {
  return formatStatuslineBarText(
    ctx,
    formatClaudeUsageLoadingBar(frame),
    "userMessageBg",
  );
}

function formatStatuslineProblem(
  ctx: ExtensionContext,
  errors: UsageQueryError[],
): string {
  const label = ctx.ui.theme.fg("accent", STATUS_LABEL_TEXT);
  const value = isUsageUnavailable(errors)
    ? ctx.ui.theme.fg("muted", "n/a")
    : ctx.ui.theme.fg("error", "error");
  return `${label} ${value}`;
}

export function isUsageUnavailable(errors: UsageQueryError[]): boolean {
  return errors.length > 0 && errors.every(isUnavailableError);
}

function isUnavailableError(error: UsageQueryError): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes("no pi anthropic subscription auth") ||
    message.includes("no displayable rate-limit windows") ||
    message.includes("returned 401") ||
    message.includes("returned 403") ||
    message.includes("unauthorized") ||
    message.includes("forbidden") ||
    message.includes("subscription") ||
    message.includes("permission")
  );
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
  if (!window) return 0;
  const remaining = remainingPercent(window);
  if (remaining <= 0) return 0;
  return Math.max(1, Math.round(remaining / (100 / totalParts)));
}

function remainingPercent(window: NormalizedRateLimitWindow): number {
  return 100 - clampPercent(window.usedPercent);
}

function isQuotaWindowExhausted(
  window: NormalizedRateLimitWindow | undefined,
): boolean {
  return window !== undefined && remainingPercent(window) <= 0;
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

function parseJsonObject(
  text: string,
  description: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `${description} was not valid JSON: ${errorMessage(error)}`,
    );
  }
  return assertObject(parsed, description);
}

function assertObject(
  value: unknown,
  description: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} was not an object.`);
  }
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asResetTime(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 10_000_000_000 ? value * SECOND_MS : value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function redactErrorBody(body: string): string {
  return truncateEnd(
    body
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
      .replace(/sk-ant-[A-Za-z0-9_-]+/g, "<redacted>")
      .replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"<redacted>"')
      .trim(),
    MAX_ERROR_BODY_CHARS,
  );
}

function truncateEnd(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
