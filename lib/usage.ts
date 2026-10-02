/** Domain: usage. Owns: Anthropic model identity, quota normalization and unavailable classification. Excludes: transport, persistence and presentation. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
export const ANTHROPIC_PROVIDER_ID = "anthropic";
const SECOND_MS = 1000;
export type ClaudeUsageModel = Pick<NonNullable<ExtensionContext["model"]>, "id" | "name" | "provider">;
export type UsageQueryError = {
  message: string;
  cause?: unknown;
};

/** `primary` is the 5-hour session window; `secondary` is the weekly window. */
export type ClaudeUsageReport = {
  primary?: NormalizedRateLimitWindow;
  secondary?: NormalizedRateLimitWindow;
};

export type NormalizedRateLimitWindow = {
  usedPercent: number;
  resetAt?: number;
};

export function isAnthropicModel(
  model: Pick<ClaudeUsageModel, "provider"> | undefined,
): boolean {
  return model?.provider === ANTHROPIC_PROVIDER_ID;
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

export function parseUsageResponse(text: string): ClaudeUsageReport {
  return normalizeUsagePayload(parseJsonObject(text, "Claude usage endpoint response"));
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
