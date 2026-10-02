import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyFastToRequest, FAST_BETA, isFastEnabled, isFastSupported, toggleFast } from "../lib/fast.ts";

test("supported Claude Opus persists speed only; disabled means absence", () => {
  const dir=mkdtempSync(join(tmpdir(),"claude-fast-")), path=join(dir,"models.json"), id="claude-opus-5-5";
  try {
    writeFileSync(path,JSON.stringify({unknown:42,providers:{anthropic:{modelOverrides:{[id]:{reasoning:true}}}}}));
    assert.equal(toggleFast(id,path),true);
    assert.deepEqual(JSON.parse(readFileSync(path,"utf8")).providers.anthropic.modelOverrides[id],{reasoning:true,speed:"fast"});
    assert.equal(isFastEnabled(id,path),true);
    assert.equal(isFastEnabled("different-model",path),false);
    assert.equal(toggleFast(id,path),false);
    assert.deepEqual(JSON.parse(readFileSync(path,"utf8")).providers.anthropic.modelOverrides[id],{reasoning:true});
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test("request Fast field and required beta are additive, preserving existing explicit speed and all native betas",()=>{
  const model="claude-opus-5-5", body={model,betas:["oauth-2025-04-20","interleaved-thinking-2025-05-14"],reasoning:{effort:"high"}};
  const result=applyFastToRequest(body,model,true);
  assert.deepEqual(result,{...body,speed:"fast",betas:[...body.betas,FAST_BETA]});
  assert.deepEqual(body.betas,["oauth-2025-04-20","interleaved-thinking-2025-05-14"]);
  assert.deepEqual(applyFastToRequest(result,model,true),result);
  for(const payload of [{model,speed:"standard"},{model,speed:undefined},{model,betas:"malformed"},{model:"wrong"},null,[]])
    assert.equal(applyFastToRequest(payload,model,true),undefined);
  assert.equal(applyFastToRequest(body,model,false),undefined);
});

test("Fast eligibility follows the Opus family, including future versions; other families never enable or adapt requests", () => {
  for (const id of ["claude-opus-5-5", "claude-opus-4-7", "claude-opus-6", "claude-opus-6-20270101"]) {
    assert.equal(isFastSupported(id), true);
    assert.deepEqual(applyFastToRequest({ model: id }, id, true), { model: id, speed: "fast", betas: [FAST_BETA] });
  }
  const dir = mkdtempSync(join(tmpdir(), "claude-fast-capability-"));
  const path = join(dir, "models.json");
  try {
    for (const id of ["claude-sonnet-5-5", "claude-haiku-4-5", "claude-fable-5", "claude-mythos-preview", "future-claude-model", "other-claude-opus-5", "claude-opusish-5"]) {
      assert.equal(isFastSupported(id), false);
      assert.equal(toggleFast(id, path), false);
      assert.equal(existsSync(path), false);
      assert.equal(applyFastToRequest({ model: id }, id, true), undefined);
    }
    const stale = '{ // preserve user configuration\n "providers": {"anthropic": {"modelOverrides": {"claude-sonnet-5-5": {"speed": "fast", "reasoning": true}}}}}\n';
    writeFileSync(path, stale);
    assert.equal(isFastEnabled("claude-sonnet-5-5", path), false);
    assert.equal(toggleFast("claude-sonnet-5-5", path), false);
    assert.equal(readFileSync(path, "utf8"), stale);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
