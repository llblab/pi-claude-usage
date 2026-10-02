import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as entry from "../index.ts";
import extension from "../lib/extension.ts";
import * as store from "../lib/usage-store.ts";
import * as usage from "../lib/usage.ts";
import * as format from "../lib/status-format.ts";
import * as status from "../lib/status.ts";

test("entrypoint is an export-only facade preserving the public runtime contract", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").trim();
  for (const line of source.split("\n"))
    assert.match(line, /^export (?:type )?\{.+\} from "\.\/lib\/[\w-]+\.ts";$/);
  assert.deepEqual(Object.keys(entry).sort(), ["LEADER_INTERVAL_MS","MIN_ATTEMPT_GAP_MS","TAKEOVER_AFTER_MS","claimRefresh","default","failureBackoffMs","formatClaudeUsageBar","formatClaudeUsageLoadingBar","formatClaudeUsageStatusValue","formatClaudeUsageStatusline","formatResetCountdown","formatWeeklyResetCountdown","isRefreshDue","isStaleExtensionContextError","isUsageUnavailable","nextRefreshAt","nextResetCountdownDelayForRemainingMs","nextResetCountdownDelayMs","normalizeUsagePayload","ownsRefreshClaim","publishRefresh","readState","tryAcquireLock","writeState"]);
  assert.equal(entry.default, extension);
  for (const [name, value] of Object.entries(entry)) {
    if (name === "default") continue;
    const owner = [store, usage, format, status].find(module => name in module)!;
    assert.equal(value, (owner as Record<string, unknown>)[name], name);
  }
});
