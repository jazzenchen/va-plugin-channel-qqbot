import assert from "node:assert/strict";
import test from "node:test";

import { QQBot } from "../dist/bot.js";
import { AgentStreamHandler } from "../dist/agent-stream.js";

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

test("QQ renderer delegates workspace files to the bot", async () => {
  const sent = [];
  const renderer = new AgentStreamHandler({
    async sendFile(...args) {
      sent.push(args);
    },
  }, () => {});
  const file = {
    path: "/workspace/report.pdf",
    name: "report.pdf",
  };

  await renderer.sendFile(target, file);

  assert.deepEqual(sent, [[target, file]]);
});

test("QQ rejects file delivery on guild routes without reading the file", async () => {
  const bot = createBot();
  bot.pending.set(target.replyTo, {
    msgId: target.replyTo,
    target: "channel-id",
    kind: "channel",
  });

  await assert.rejects(
    bot.sendFile(target, {
      path: "/does/not/exist",
      name: "report.pdf",
    }),
    /only supported in C2C and group chats/,
  );
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
