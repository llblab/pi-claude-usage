# Agent Notes

- `Statusline-first scope`: Keep this extension zero-configuration and focused on compact status surfaces.
  - Trigger: Considering commands, menus, persisted settings, or notification output.
  - Action: Prefer deleting the surface unless it is required for the optimistic TUI status widget or the optional `pi-telegram` `/start` status-line mirror.
- `Optimistic refresh`: Preserve the last good statusline bar during refresh and transient failures.
  - Trigger: Updating quota polling or error handling.
  - Action: Do not collapse the bar while a request is in flight; only show `n/a` or `error` after repeated failures or no usable quota.
- `Adaptive compact status`: Match the status representation to the server-provided quota windows.
  - Trigger: Changing statusline formatting.
  - Action: When both windows exist, keep the classic dual bar with 20 top steps for the 5-hour window and 20 bottom steps for the weekly window. When only one weekly window exists, show its rounded remaining percentage directly instead of using a bar.
- `Weekly reset countdown`: Append the weekly reset countdown whenever the available weekly window exposes a reset time.
  - Trigger: Changing reset-time normalization or statusline refresh cadence.
  - Action: Map `five_hour` to the primary window and `seven_day` to the secondary (weekly) window; treat a sole window as weekly. Keep `d` labels rounded upward in 144-minute day-tenth steps above 24h, show 24h..1h labels in upward-rounded 6-minute hour-tenth steps, keep `m`/`s` labels floored, and hold `0s` until a successful quota refresh reports the next window.
- `Pi auth only`: Usage is read from `https://api.anthropic.com/api/oauth/usage` with the Pi `anthropic` provider OAuth token (`sk-ant-oat…`) and the `anthropic-beta: oauth-2025-04-20` header.
  - Trigger: Touching auth or adding usage sources.
  - Action: Do not add fallbacks, CLI probes, or API-key paths; API keys have no subscription quota, so report `n/a`. `utilization` is a used percent.
- `Rate-limit discipline`: Quota polling must be shared across instances; HTTP 429 triggers shared backoff.
  - Trigger: Changing refresh cadence, retries, locking, or adding fetch paths.
  - Action: Keep the single shared-state protocol in the `Shared Refresh` section of `index.ts` (leader refreshes every minute, takeover after 90 seconds by claiming leadership before fetching, a non-waiting OS-backed SQLite mutex around claiming and fenced publication, atomic writes, shared failure backoff). Always re-read the file for request authorization (`owner` + `claimId` + lease) and publication; do not use an in-memory ownership fallback. Lock failures and failed claim writes must deny requests. `mutex.sqlite` stores no quota or leadership data: never unlink/replace it while instances run or evict a paused holder; close or process death releases the mutex. Keep network calls outside critical sections. Instances otherwise only read the file; never add per-instance polling or probing requests.
