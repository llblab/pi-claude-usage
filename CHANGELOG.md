# Changelog

## 0.1.0: Claude Subscription Usage

- Initial standalone release, adapted from [pi-codex-usage](https://github.com/llblab/pi-codex-usage), for Claude Pro/Max subscriptions. Reads the 5-hour and 7-day quota windows using Pi's Anthropic OAuth login; API-key-only auth reports `n/a`.
- Shows remaining quota in a compact dual bar, with reset countdowns, animated loading, exhausted-quota highlighting, and optimistic display during refreshes or transient failures. A single available window uses a remaining percentage. Optionally mirrors the same value in the `pi-telegram` status menu.
- Coordinates all local Pi instances through one shared `usage.json`: the leader refreshes every minute, followers normally read every 30 seconds, and takeover becomes eligible after 90 seconds. Shared failure backoff, including HTTP 429, prevents independent polling.
- Uses an OS-backed SQLite mutex, atomic JSON writes, and on-disk claim generation/lease checks to deny requests when coordination fails and discard superseded results. Requires Node ≥22.19.0 and a local filesystem. **Upgrade from development versions:** close all old Pi sessions before starting this version; never delete or replace `mutex.sqlite` while sessions run.
