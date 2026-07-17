import assert from "node:assert/strict";
import test from "node:test";

import {
  isProtocolStdoutLine,
  safeErrorCategory,
  SILENT_UPSTREAM_LOGGER,
} from "../dist/log-policy.js";

test("upstream API logger discards every message", () => {
  const secret = "clientSecret=secret-value request={user content}";
  for (const method of ["info", "error", "warn", "debug"]) {
    assert.equal(SILENT_UPSTREAM_LOGGER[method](secret), undefined);
  }
});

test("error categories never copy raw error text", () => {
  assert.equal(safeErrorCategory(new Error("secret-value")), "unknown");
  assert.equal(
    safeErrorCategory({ name: "ApiError", status: 401, message: "secret-value" }),
    "http_401",
  );
  assert.equal(safeErrorCategory({ code: "ETIMEDOUT", message: "signed-url" }), "timeout");
  assert.equal(safeErrorCategory({ code: "ECONNRESET", body: "user-content" }), "network");
});

test("only protocol-shaped stdout lines are admitted", () => {
  assert.equal(isProtocolStdoutLine('{"jsonrpc":"2.0","id":1,"result":{}}'), true);
  assert.equal(
    isProtocolStdoutLine('  {"jsonrpc":"2.0","method":"session/update","params":{}}'),
    true,
  );
  assert.equal(isProtocolStdoutLine('{"jsonrpc":"2.0"}'), false);
  assert.equal(isProtocolStdoutLine('{"access_token":"secret-value"}'), false);
  assert.equal(isProtocolStdoutLine("[qqbot-api] secret-value"), false);
  assert.equal(isProtocolStdoutLine("request body: user-content"), false);
});
