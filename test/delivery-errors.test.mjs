import assert from "node:assert/strict";
import test from "node:test";

import { QQBot } from "../dist/bot.js";

const target = {
  channelInstanceId: "instance",
  actorId: "actor",
  chatId: "chat",
  replyTo: "message",
};

function createBot(log = () => {}) {
  return new QQBot(
    { app_id: "app", secret: "secret" },
    {},
    log,
    "/tmp",
    "instance",
    "actor",
  );
}

test("sendText rejects when the pending reply context is missing", async () => {
  const logs = [];
  const bot = createBot((level, message) => logs.push({ level, message }));

  await assert.rejects(
    bot.sendText(target, "reply"),
    /QQ reply context is unavailable/,
  );
  assert.deepEqual(logs, []);
});

test("sendText propagates QQ API failures without logging locally", async (t) => {
  const logs = [];
  const bot = createBot((level, message) => logs.push({ level, message }));
  bot.pending.set(target.replyTo, {
    msgId: target.replyTo,
    target: "openid",
    kind: "c2c",
  });
  bot.ensureToken = async () => "token";

  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(
    JSON.stringify({ message: "sensitive upstream response" }),
    {
      status: 500,
      headers: { "content-type": "application/json" },
    },
  );

  await assert.rejects(bot.sendText(target, "reply"));
  assert.deepEqual(logs, []);
});
