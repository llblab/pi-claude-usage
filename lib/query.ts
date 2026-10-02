/** Domain: quota query. Owns: Pi OAuth selection, guarded HTTP, timeout, Retry-After and error redaction. Excludes: lease mutation, Fast and display. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ANTHROPIC_PROVIDER_ID, parseUsageResponse, type ClaudeUsageReport } from "./usage.ts";
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";
const SECOND_MS = 1000;
const MAX_ERROR_BODY_CHARS = 600;
type PiModel = NonNullable<ExtensionContext["model"]>;

export type QueryUsageResult =
  | { ok: true; report: ClaudeUsageReport }
  | {
      ok: false;
      message: string;
      rateLimited: boolean;
      retryAfterMs?: number;
    };

export async function queryUsage(
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

    return { ok: true, report: parseUsageResponse(text) };
  } catch (cause) {
    return { ok: false, message: errorMessage(cause), rateLimited: false };
  }
}

function parseRetryAfterMs(value: string | null): number | undefined {
  const seconds = value === null ? NaN : Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * SECOND_MS : undefined;
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
