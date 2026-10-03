/** Domain: Telegram status. Owns: optional status-provider discovery and registration. Excludes: quota state and terminal decoration. */
import { isFastEnabled } from "./fast.ts";
import { isAnthropicModel, type ClaudeUsageModel, type ClaudeUsageReport } from "./usage.ts";
import { formatClaudeUsageStatusValue, STATUS_LABEL_TEXT } from "./status-format.ts";
const CLAUDE_USAGE_EXTENSION_ID = "@llblab/pi-claude-usage";
const TELEGRAM_STATUS_IMPORT_SPECIFIERS = [
  "@llblab/pi-telegram/status",
  new URL("../../pi-telegram/api/status.ts", import.meta.url).href,
];

type TelegramStatusLineProviderResult =
  { label: string; value: string } | undefined;
type TelegramStatusLineProvider = (ctx: {
  activeModel?: ClaudeUsageModel;
}) => TelegramStatusLineProviderResult;
type TelegramStatusLineModule = {
  registerTelegramStatusLineProvider?: (
    provider: TelegramStatusLineProvider,
    options: { id: string },
  ) => () => void;
};

/** Read the selected model's preference at menu render time, not from the terminal cache. */
export function claudeUsageTelegramStatusLine(
  report: ClaudeUsageReport | undefined,
  activeModel: ClaudeUsageModel | undefined,
): TelegramStatusLineProviderResult {
  if (!activeModel || !isAnthropicModel(activeModel)) return undefined;
  const value = report ? formatClaudeUsageStatusValue(report) : undefined;
  const fast = isFastEnabled(activeModel.id);
  if (!value && !fast) return undefined;
  return { label: STATUS_LABEL_TEXT, value: value ? `${value}${fast ? " fast" : ""}` : "fast" };
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

export async function registerClaudeUsageTelegramStatusLine(
  provider: TelegramStatusLineProvider,
): Promise<(() => void) | undefined> {
  const telegramStatus = await importTelegramStatusLineModule();
  return telegramStatus?.registerTelegramStatusLineProvider?.(provider, {
    id: CLAUDE_USAGE_EXTENSION_ID,
  });
}
