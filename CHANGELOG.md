# Changelog

## 0.2.1: Telegram Fast Status

- The optional Telegram status row now appends lowercase ` fast` for the active eligible Opus model, or shows `fast` alone when quota is unavailable. It rereads the per-model preference at menu render time, so toggles and model changes do not wait for quota refresh. Unsupported Claude families ignore stale Fast overrides. Quota polling, auth, request adaptation and terminal behavior are unchanged; isolated tests cover eligibility, model/provider changes and unreadable configuration.

## 0.2.0: Shared Fast Mode and Pi 1.0 Baseline

- Split the monolithic extension into cohesive `lib/` domains matching Codex Usage: composition, status lifecycle, shared state, OAuth query, quota normalization, formatting, Telegram and Fast. `index.ts` now only re-exports the unchanged public API; tests follow domain owners. Quota/auth/leadership, mutex/fencing/backoff, status redraw and Fast behavior are preserved.
- Added an argument-free `/fast` provider handler through `@llblab/pi-command-fast@^0.1.0`, sharing exactly one command with Codex Usage across load orders, duplicate dependency copies, independent sessions and reloads. Claude eligibility is restricted to the Opus family without a version allowlist; other families receive `Fast mode is supported only for Opus` without writes or quota requests, and stale unsupported overrides do not decorate status or activate the request bridge. Generic command dispatch and Codex eligibility are unchanged.
- Persisted `speed: "fast"` solely in the current Anthropic model override; OFF deletes it. The shared JSONC helper preserves comments and unrelated configuration with atomic replacement.
- Requires Pi ≥1.0.0 across coding-agent, AI and agent-core peers: older Anthropic transports do not expose the same assembled beta payload contract. Adapted native payloads with Fast speed and additive `fast-mode-2026-02-01` beta, preserving explicit speed and Pi-generated/configured betas through actual HTTP assembly. No provider replacement or header-default suppression.
- Appended dim lowercase ` fast` at the final terminal status boundary, including loading/error/n/a paths, with immediate silent redraw and no quota request. OAuth quota polling, SQLite mutex, claim fencing, stale display, retry/backoff, and Telegram remain unchanged. Tests now live in `tests/`.

## 0.1.1: Trusted CI Publication

- Releases use the configured npm Trusted Publisher for GitHub Actions, with provenance and workflow-owned GitHub Release creation. Public-package verification now allows approximately 30 minutes for npm processing, with a 35-minute step limit, while retaining exact commit and package-inventory checks.
- Quota polling, OAuth authentication, shared-state coordination, and statusline behavior are unchanged from 0.1.0.

## 0.1.0: Claude Subscription Usage

- Initial standalone release, adapted from [pi-codex-usage](https://github.com/llblab/pi-codex-usage), for Claude Pro/Max subscriptions. Reads the 5-hour and 7-day quota windows using Pi's Anthropic OAuth login; API-key-only auth reports `n/a`.
- Shows remaining quota in a compact dual bar, with reset countdowns, animated loading, exhausted-quota highlighting, and optimistic display during refreshes or transient failures. A single available window uses a remaining percentage. Optionally mirrors the same value in the `pi-telegram` status menu.
- Coordinates all local Pi instances through one shared `usage.json`: the leader refreshes every minute, followers normally read every 30 seconds, and takeover becomes eligible after 90 seconds. Shared failure backoff, including HTTP 429, prevents independent polling.
- Uses an OS-backed SQLite mutex, atomic JSON writes, and on-disk claim generation/lease checks to deny requests when coordination fails and discard superseded results. Requires Node ≥22.19.0 and a local filesystem. **Upgrade from development versions:** close all old Pi sessions before starting this version; never delete or replace `mutex.sqlite` while sessions run.
