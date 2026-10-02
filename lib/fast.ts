/** Domain: Claude Fast. Owns: provider semantics and native request beta adaptation. Excludes: quota and command ownership. */
import { isModelOverrideValue, toggleModelOverrideValue } from "@llblab/pi-command-fast";

export const FAST_BETA = "fast-mode-2026-02-01";
export function isFastSupported(modelId: string): boolean {
  return modelId.startsWith("claude-opus-");
}
const target = (id: string) => ({ provider: "anthropic", id, property: "speed", enabledValue: "fast" });
export function isFastEnabled(modelId: string, path?: string): boolean {
  return isFastSupported(modelId) && isModelOverrideValue(target(modelId), path);
}
export function toggleFast(modelId: string, path?: string): boolean {
  return isFastSupported(modelId) && toggleModelOverrideValue(target(modelId), path);
}

/** Pi assembles automatic/configured betas before this hook; the Anthropic SDK converts betas to the HTTP header. */
export function applyFastToRequest(payload: unknown, modelId: string, enabled: boolean): unknown {
  if (!enabled || !isFastSupported(modelId) || !payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const body = payload as Record<string, unknown>;
  if (body.model !== modelId || ("speed" in body && body.speed !== "fast")) return undefined;
  if ("betas" in body && !Array.isArray(body.betas)) return undefined;
  const betas = Array.isArray(body.betas) ? body.betas : [];
  return { ...body, speed: "fast", betas: [...new Set([...betas, FAST_BETA])] };
}
