# pi-claude-usage

> Minimal zero-configuration Pi extension for showing Anthropic Claude subscription usage limits in the statusline

![Claude Usage](./banner.jpg)

This repository is an adaptation of [`pi-codex-usage`](https://github.com/llblab/pi-codex-usage) for Anthropic Claude Pro/Max subscriptions. It keeps the statusline design, but reads quota from the Anthropic OAuth usage endpoint using Pi's own Anthropic login.

## Start Here

- [Agent Notes](./AGENTS.md)
- [Backlog](./BACKLOG.md)
- [Changelog](./CHANGELOG.md)

## Features

- Shows two counter-moving half-height markers in the statusline bar while quota is loading, then keeps the bar fresh (the countdown ticks locally)
- Keeps the last usable bar visible during ordinary refreshes instead of replacing known quota with a loading state
- Dual bar: the top half shows the 5-hour session window and the bottom half shows the 7-day window, 20 steps (5% each) per window
- If only one window is returned, shows its remaining percentage and reset countdown instead of a bar
- Shown only while the active model uses the Pi `anthropic` provider
- When `pi-telegram` is available, the same compact value appears as `claude: <value>` in the `/start` menu status text
- Missing OAuth auth, API-key-only auth, or missing quota windows are shown as `n/a`, not as an error
- Network/provider failures keep the last good bar, then show `error` after repeated failures
- Any number of Pi instances share one request stream, see [Shared Refresh](#shared-refresh)
- No commands or configuration are required

## Install

From npm:

```bash
pi install npm:@llblab/pi-claude-usage
```

From git:

```bash
pi install git:github.com/llblab/pi-claude-usage
```

## Statusline

```text
claude ██████▀▀▀▀ 6d
```

The ten-character bar encodes two twenty-step limits at once: the top quadrants show the remaining 5-hour limit and the bottom quadrants show the remaining weekly limit. If either window is exhausted, the bar keeps its shape but switches to the error background color.

When the weekly reset time is available, it follows the bar. More than a day remains is shown in 144-minute day-tenth steps such as `7d`, `6.9d`, `1.1d`, rounded upward. At 24 hours and below it switches to upward-rounded hour-tenths such as `24h`, `23.7h`, `1.1h`, `1h`. Under an hour it shows floored minutes, then seconds. After the reset passes, `0s` is held until the next successful refresh.

When the 5-hour window is exhausted and exposes its reset time, the statusline adds it before the weekly reset:

```text
claude ▄▄▄▄▄⠀⠀⠀⠀⠀ 5h/7d
```

If only one window is returned, the exact remaining percentage is shown:

```text
claude 67% 7d
```

Unavailable (no Anthropic subscription auth):

```text
claude n/a
```

Runtime failure, such as a network or provider error (including rate limiting of the usage endpoint):

```text
claude error
```

## Shared Refresh

The coordination code lives in the `Shared Refresh` section of [`index.ts`](./index.ts); the extension ships as a single TypeScript source file.

To avoid independent polling, instances coordinate through `~/.pi/agent/tmp/pi-claude-usage/usage.json` (percentages and timestamps only, no tokens):

- The instance that last updated the file is the leader and refreshes it every minute
- Every other instance only reads the file (re-checking every ≤30s) and redraws when it changes
- Leadership is never cached in memory: before each usage request, the instance re-reads the file and checks its `owner`, unique `claimId`, and 90s lease. Publication rechecks that claim under the lock; a superseded success or failure is discarded. Failed locks or unwritten claims never authorize a request
- If the file is 90 seconds old (leader is closed, busy, or asleep), the first follower that obtains the mutex takes over: it re-reads the JSON, writes itself as the leader with a fresh timestamp, releases the mutex, then fetches from the server and publishes under the mutex after rechecking its claim. Its next refresh is one minute later; JSON writes remain atomic renames
- Claiming and publication use a non-waiting transaction in `mutex.sqlite`, through Node's built-in `node:sqlite` (Node ≥22.19.0, the existing package minimum). It stores no quota or leadership records and needs no extra package or service. The OS releases the lock when the connection closes or the process dies; there is no timeout-based lock stealing
- Failures are written to the file with an exponential backoff (1 to 5 minutes; 5 to 30 minutes for HTTP 429) that applies to all instances
- The last report stays visible for up to an hour; after that `error` is shown

Coordination assumes a local filesystem and cooperating instances on the same machine. Never delete or replace `mutex.sqlite` while instances are running. Network requests do not hold the mutex; a process paused inside a short critical section keeps it until it resumes or exits, so other writers retry later without blocking the TUI. This preserves exclusion instead of stealing a live lock.

**Upgrade:** Close all old instances before starting updated ones. The legacy `lock` files are ignored; old and new locking protocols must not run together. Cached `usage.json` data needs no migration.

## Telegram Status Menu

If `@llblab/pi-telegram` is loaded with the public status-line provider API, this extension registers an optional `/start` menu status row while the active model uses the Anthropic provider:

```text
claude: ██████▀▀▀▀ 6d
```

If `pi-telegram` is absent or older, or the active model is not Anthropic, no Telegram row is added.

## Auth

The extension uses the OAuth token of Pi's `anthropic` provider (`/login` → Anthropic Claude Pro/Max) and calls `GET https://api.anthropic.com/api/oauth/usage` with the `anthropic-beta: oauth-2025-04-20` header. Pi refreshes the token as needed. Anthropic API keys are not subscription auth and do not expose these quotas.

## License

MIT. See [`LICENSE`](./LICENSE).
