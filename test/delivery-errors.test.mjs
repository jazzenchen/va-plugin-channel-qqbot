import assert from "node:assert/strict";
import test from "node:test";

import { AgentStreamHandler } from "../dist/agent-stream.js";
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
  assert.deepEqual(logs, [{
    level: "warn",
    message: "sendText failed category=missing_context",
  }]);
});

test("sendText propagates QQ API failures without logging response content", async (t) => {
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
  assert.deepEqual(logs, [{
    level: "error",
    message: "sendText failed category=http_500",
  }]);
  assert.equal(logs.some(({ message }) => message.includes("sensitive")), false);
});

test("onTurnEnd rejects when QQ block delivery fails", async () => {
  const deliveryError = new Error("QQ delivery failed");
  const renderer = new AgentStreamHandler({
    async sendText() {
      throw deliveryError;
    },
  }, () => {});

  renderer.onPromptSent(target);
  renderer.onSessionUpdate(target, {
    sessionId: "session",
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId: "agent-message",
      content: { type: "text", text: "answer" },
    },
  });

  await assert.rejects(
    renderer.onTurnEnd(target),
    (error) => error === deliveryError,
  );
});
