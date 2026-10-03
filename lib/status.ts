/** Domain: status lifecycle. Owns: guarded refresh orchestration, stale display, terminal timers and optional Telegram row. Excludes: command arbitration and request adaptation. */
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { isFastEnabled } from "./fast.ts";
import { claimRefresh, isRefreshDue, nextRefreshAt, ownsRefreshClaim, publishRefresh, readState, MIN_ATTEMPT_GAP_MS, type SharedState } from "./usage-store.ts";
import { isAnthropicModel, type ClaudeUsageModel, type ClaudeUsageReport } from "./usage.ts";
import { DUAL_BAR_WIDTH, formatClaudeUsageBar, formatClaudeUsageStatusline, formatStatuslineLoading, formatStatuslineProblem, nextResetCountdownDelayMs } from "./status-format.ts";
import { queryUsage } from "./query.ts";
import { claudeUsageTelegramStatusLine, registerClaudeUsageTelegramStatusLine } from "./telegram.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
/** How often an instance re-reads the shared file to redraw fresh data. */
const MAX_TICK_MS = 30 * SECOND_MS;
const MIN_TICK_MS = SECOND_MS;
const TAKEOVER_JITTER_MS = 2 * SECOND_MS;
/** A report older than this is no longer shown as current. */
const STALE_REPORT_MAX_AGE_MS = HOUR_MS;
const LOADING_FRAME_MS = 30;
const REDRAW_BLINK_MS = 150;
const STATUS_KEY = "aa-claude-usage";

type TimeoutHandle = ReturnType<typeof setTimeout> & { unref?: () => void };

export function createClaudeUsageStatus(pi: ExtensionAPI) {
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
  let fastEnabled = false;
  let fastModelId: string | undefined;
  let lastStatusText: string | undefined;

  const syncFast = (model: ClaudeUsageModel | undefined) => {
    fastModelId = isAnthropicModel(model) ? model?.id : undefined;
    fastEnabled = fastModelId !== undefined && isFastEnabled(fastModelId);
  };
  const setClaudeStatus = (ctx: ExtensionContext, text: string | undefined) => {
    lastStatusText = text;
    ctx.ui.setStatus(STATUS_KEY, text !== undefined && fastEnabled
      ? `${text} ${ctx.ui.theme.fg("dim", "fast")}` : text);
  };

  const loadState = () => readState(stateDir);

  const ensureTelegramStatusLineRegistered = () => {
    if (unregisterTelegramStatusLine || telegramStatusLineRegistration) return;
    telegramStatusLineRegistration = registerClaudeUsageTelegramStatusLine(
      ({ activeModel }) => claudeUsageTelegramStatusLine(shown.report, activeModel),
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
        setClaudeStatus(ctx, formatStatuslineLoading(ctx, statuslineLoadingFrame));
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
    setClaudeStatus(ctx, undefined);
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
          setClaudeStatus(ctx, formatClaudeUsageStatusline(report, ctx));
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
      setClaudeStatus(ctx, formatStatuslineLoading(ctx, statuslineLoadingFrame));
      statuslineBlinkTimer = setTimeout(() => {
        try {
          setClaudeStatus(ctx, text);
          scheduleStatuslineCountdown(ctx, report);
          statuslineBlinkTimer = undefined;
        } catch (error) {
          handleTimerError(error);
        }
      }, REDRAW_BLINK_MS) as TimeoutHandle;
      statuslineBlinkTimer.unref?.();
    } else {
      setClaudeStatus(ctx, text);
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
      setClaudeStatus(ctx, formatStatuslineProblem(ctx, [{ message: state.error }]));
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
    model?: ClaudeUsageModel,
  ) => {
    try {
      const previousFast = fastEnabled;
      syncFast(model ?? ctx.model);
      forceRender ||= previousFast !== fastEnabled;
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
    syncFast(event.model);
    if (lastStatusText !== undefined) setClaudeStatus(ctx, lastStatusText);
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
  return {
    fastChanged(ctx: ExtensionContext, model: ClaudeUsageModel) {
      syncFast(model);
      if (lastStatusText !== undefined) setClaudeStatus(ctx, lastStatusText);
      else renderState(ctx, loadState(), true);
    },
  };
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
