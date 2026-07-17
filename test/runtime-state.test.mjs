import assert from "node:assert/strict";
import test from "node:test";

import WebSocket from "ws";
import { QQBot, buildAttachmentCacheFileName } from "../dist/bot.js";

test("same-name attachments from different messages use different cache files", () => {
  const first = buildAttachmentCacheFileName("msg-1", 0, "report.pdf", "application/pdf");
  const second = buildAttachmentCacheFileName("msg-2", 0, "report.pdf", "application/pdf");
  assert.notEqual(first, second);
});

test("missing heartbeat ACK terminates the stale gateway", async () => {
  let heartbeats = 0;
  let terminated = false;
  const bot = new QQBot(
    { app_id: "app", secret: "secret" },
    {},
    () => {},
    "/tmp",
    "instance",
    "actor",
  );
  bot.ws = {
    readyState: WebSocket.OPEN,
    send() { heartbeats += 1; },
    terminate() { terminated = true; },
    close() {},
  };

  bot.handleFrame({ op: 10, d: { heartbeat_interval: 5 } });
  await new Promise((resolve) => setTimeout(resolve, 15));
  await bot.stop();

  assert.equal(heartbeats, 1);
  assert.equal(terminated, true);
});
