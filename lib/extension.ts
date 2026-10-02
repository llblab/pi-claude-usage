/** Domain: extension composition. Owns: provider registration, Fast request bridge and status wiring. Excludes: quota, persistence and presentation policy. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerFastProvider } from "@llblab/pi-command-fast";
import { applyFastToRequest, isFastEnabled, isFastSupported, toggleFast } from "./fast.ts";
import { ANTHROPIC_PROVIDER_ID, isAnthropicModel } from "./usage.ts";
import { createClaudeUsageStatus } from "./status.ts";

export default function claudeUsage(pi: ExtensionAPI) {
  let releaseFast: (() => void) | undefined;
  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (!model || !isAnthropicModel(model)) return;
    return applyFastToRequest(event.payload, model.id, isFastEnabled(model.id));
  });
  pi.on("session_start", (_event, ctx) => {
    releaseFast = registerFastProvider(pi, ctx, {
      provider: ANTHROPIC_PROVIDER_ID,
      toggle(commandCtx) {
        if (!isFastSupported(commandCtx.model!.id)) {
          commandCtx.ui.notify("Fast mode is supported only for Opus", "warning");
          return;
        }
        toggleFast(commandCtx.model!.id);
        status.fastChanged(commandCtx, commandCtx.model!);
      },
    });
  });
  pi.on("session_shutdown", () => { releaseFast?.(); releaseFast = undefined; });
  const status = createClaudeUsageStatus(pi);
}
