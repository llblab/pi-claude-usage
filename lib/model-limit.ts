/** Domain: model limit signal. Owns: narrow subscription-error recognition and near-empty window inference. Excludes: quota measurement, persistence, requests and rendering. */
import type { ExtensionContext, MessageEndEvent } from "@earendil-works/pi-coding-agent";
import type { ClaudeUsageReport } from "./usage.ts";

/** Empirical subscription budget estimate, not an Anthropic quota guarantee. */
const WEEKLY_TO_FIVE_HOUR_BUDGET_RATIO = 6;

/** Infer at most one near-empty window, comparing balances in five-hour budget units. */
export function applyModelRateLimit(report: ClaudeUsageReport): ClaudeUsageReport {
  const primaryRemaining = report.primary ? 100 - report.primary.usedPercent : Infinity;
  const secondaryRemaining = report.secondary ? 100 - report.secondary.usedPercent : Infinity;
  if (primaryRemaining <= 0 || secondaryRemaining <= 0) return report;
  const primaryNearEmpty = primaryRemaining < 5;
  const secondaryNearEmpty = secondaryRemaining < 5;
  if (!primaryNearEmpty && !secondaryNearEmpty) return report;
  const selected = primaryNearEmpty && (!secondaryNearEmpty ||
    primaryRemaining <= WEEKLY_TO_FIVE_HOUR_BUDGET_RATIO * secondaryRemaining)
    ? "primary" : "secondary";
  return { ...report, [selected]: { ...report[selected], usedPercent: 100 } };
}

const ACCOUNT_RATE_LIMIT_MESSAGE = "This request would exceed your account's rate limit. Please try again later.";

/** This display signal does not prove which quota window is exhausted. */
export function isSubscriptionRateLimit(
  message: MessageEndEvent["message"],
  model: ExtensionContext["model"],
  usingOAuth: boolean,
): boolean {
  if (
    !usingOAuth ||
    !model ||
    model.provider !== "anthropic" ||
    model.api !== "anthropic-messages" ||
    model.baseUrl.replace(/\/+$/, "") !== "https://api.anthropic.com" ||
    !model.id.startsWith("claude-") ||
    message.role !== "assistant" ||
    message.provider !== model.provider ||
    message.api !== model.api ||
    message.model !== model.id ||
    message.stopReason !== "error"
  ) return false;
  const match = message.errorMessage?.match(/^(?:Error:\s*)?429\s+(\{[\s\S]*\})\s*$/);
  if (!match) return false;
  try {
    const body = JSON.parse(match[1]);
    return body?.type === "error" &&
      body.error?.type === "rate_limit_error" &&
      typeof body.error.message === "string" &&
      body.error.message.replace(/\s+/g, " ").trim() === ACCOUNT_RATE_LIMIT_MESSAGE;
  } catch {
    return false;
  }
}
