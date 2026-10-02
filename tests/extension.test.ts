import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import claudeUsage from "../index.ts";
import { isFastEnabled } from "../lib/fast.ts";

test("every declared Pi peer has the 1.0.0 minimum", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  for (const [name, range] of Object.entries(pkg.peerDependencies))
    if (name.startsWith("@earendil-works/")) assert.equal(range, ">=1.0.0", name);
});

test("provider-level shared /fast persists, dispatches, redraws every status and never fetches quota", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-fast-claude-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const previousFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error("Unexpected quota fetch"); };
  process.env.PI_CODING_AGENT_DIR = dir;
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const commands: Array<(args: string, ctx: any) => Promise<void>> = [];
  const statuses: Array<string | undefined> = [];
  const notices: string[] = [];
  const themeCalls: string[][] = [];
  const model = { id: "claude-opus-5-5", name: "Opus 5.5", provider: "anthropic", api: "anthropic-messages" };
  const ctx = { sessionManager: {}, model, ui: {
    setStatus: (key: string, text: string | undefined) => { assert.equal(key, "aa-claude-usage"); statuses.push(text); },
    notify: (text: string) => notices.push(text),
    theme: { fg: (role: string, text: string) => { themeCalls.push([role, text]); return text; }, bg: (_: string, text: string) => text },
  } };
  const emit = async (name: string, event: object = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };
  const stateDir = join(dir, "tmp", "pi-claude-usage");
  mkdirSync(stateDir, { recursive: true });
  const publish = (data: object) => writeFileSync(join(stateDir, "usage.json"), JSON.stringify({ ...data, owner: "other", claimedAt: Date.now(), updatedAt: Date.now() }));
  publish({ report: { secondary: { usedPercent: 33 } } });
  try {
    claudeUsage({
      on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
      registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) { assert.equal(name, "fast"); commands.push(options.handler); },
    } as never);
    assert.equal(commands.length, 0);
    await emit("session_start");
    assert.equal(commands.length, 1);
    const command = commands[0];
    await command("on", ctx);
    assert.equal(notices.pop(), "Usage: /fast");
    await command("", { ...ctx, model: { ...model, provider: "deepseek" } });
    assert.equal(notices.pop(), "Fast mode is not supported for the current provider");
    assert.equal(existsSync(join(dir, "models.json")), false);
    const unsupported = { ...model, id: "claude-sonnet-5-5", name: "Sonnet 5.5" };
    await command("", { ...ctx, model: unsupported });
    assert.equal(notices.pop(), "Fast mode is supported only for Opus");
    assert.equal(existsSync(join(dir, "models.json")), false);
    await command("", ctx);
    assert.equal(isFastEnabled(model.id), true);
    assert.equal(statuses.at(-1), "claude 67% fast");
    assert.ok(themeCalls.some(([role, text]) => role === "dim" && text === "fast"));
    assert.equal(notices.length, 0);
    const request = handlers.get("before_provider_request")![0];
    assert.deepEqual(request({ payload: { model: model.id } }, ctx), { model: model.id, speed: "fast", betas: ["fast-mode-2026-02-01"] });
    assert.equal(request({ payload: { model: model.id, speed: "standard" } }, ctx), undefined);
    assert.equal(request({ payload: { model: "different" } }, ctx), undefined);
    const beforeUnsupported = readFileSync(join(dir, "models.json"), "utf8");
    await command("", { ...ctx, model: unsupported });
    notices.pop();
    assert.equal(readFileSync(join(dir, "models.json"), "utf8"), beforeUnsupported);
    const stale = JSON.parse(beforeUnsupported);
    stale.providers.anthropic.modelOverrides[unsupported.id] = { speed: "fast" };
    writeFileSync(join(dir, "models.json"), JSON.stringify(stale));
    ctx.model = unsupported;
    await emit("model_select", { model: unsupported });
    assert.equal(statuses.at(-1), "claude 67%");
    assert.equal(request({ payload: { model: unsupported.id } }, ctx), undefined);
    const other = { ...model, id: "another-future-model" };
    ctx.model = other;
    await emit("model_select", { model: other });
    assert.equal(statuses.at(-1), "claude 67%");
    ctx.model = model;
    await emit("model_select", { model });
    assert.equal(statuses.at(-1), "claude 67% fast");
    for (const [data, expected] of [
      [{ error: "no Pi anthropic subscription auth", unavailable: true }, "claude n/a fast"],
      [{ error: "network failure" }, "claude error fast"],
      [{ report: { primary: { usedPercent: 19 } } }, "claude 81% fast"],
      [{ report: { primary: { usedPercent: 25 }, secondary: { usedPercent: 50 } } }, null],
    ] as const) {
      publish(data);
      await emit("model_select", { model });
      await new Promise(resolve => setTimeout(resolve, 180));
      if (expected) assert.equal(statuses.at(-1), expected);
      else assert.match(statuses.at(-1)!, /^claude .+ fast$/);
    }
    publish({});
    await emit("model_select", { model });
    assert.match(statuses.at(-1)!, / fast$/); // Loading also passes through the one terminal boundary.
    await command("", ctx);
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal(isFastEnabled(model.id), false);
    assert.doesNotMatch(statuses.at(-1)!, / fast$/);
    assert.equal(request({ payload: { model: model.id } }, ctx), undefined);
    writeFileSync(join(dir, "models.json"), '{ "providers": ');
    await emit("model_select", { model });
    assert.doesNotMatch(statuses.at(-1)!, / fast$/);
    await command("", ctx);
    assert.match(notices.at(-1)!, /^Could not update models\.json:/);
    assert.equal(readFileSync(join(dir, "models.json"), "utf8"), '{ "providers": ');
    assert.equal(fetches, 0);
  } finally {
    await emit("session_shutdown");
    globalThis.fetch = previousFetch;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
