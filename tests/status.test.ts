import assert from "node:assert/strict";
import test from "node:test";
import { isStaleExtensionContextError } from "../lib/status.ts";

test("detects stale extension context errors", () => {
  assert.equal(
    isStaleExtensionContextError(
      new Error(
        "This extension ctx is stale after session replacement or reload.",
      ),
    ),
    true,
  );
  assert.equal(
    isStaleExtensionContextError(new Error("network failed")),
    false,
  );
  assert.equal(isStaleExtensionContextError("ctx is stale"), false);
});
