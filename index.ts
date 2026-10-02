/** Domain: package entrypoint. Owns: public re-exports. Excludes: composition and behavior. */
export { default } from "./lib/extension.ts";
export { LEADER_INTERVAL_MS, TAKEOVER_AFTER_MS, MIN_ATTEMPT_GAP_MS, readState, writeState, claimRefresh, ownsRefreshClaim, publishRefresh, nextRefreshAt, isRefreshDue, failureBackoffMs, tryAcquireLock } from "./lib/usage-store.ts";
export type { SharedState, RefreshClaim, RefreshOutcome } from "./lib/usage-store.ts";
export { normalizeUsagePayload, isUsageUnavailable } from "./lib/usage.ts";
export type { ClaudeUsageReport, NormalizedRateLimitWindow, UsageQueryError } from "./lib/usage.ts";
export { formatClaudeUsageStatusline, formatClaudeUsageBar, formatClaudeUsageStatusValue, formatWeeklyResetCountdown, formatResetCountdown, nextResetCountdownDelayMs, nextResetCountdownDelayForRemainingMs, formatClaudeUsageLoadingBar } from "./lib/status-format.ts";
export { isStaleExtensionContextError } from "./lib/status.ts";
