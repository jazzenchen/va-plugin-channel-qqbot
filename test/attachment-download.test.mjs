import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { QQBot } from "../dist/bot.js";

function context(platformMessageId, channelInstanceId = "instance") {
  return {
    channelInstanceId,
    actorId: "actor",
    chatId: "chat",
    platformMessageId,
    scope: "dm",
    addressedBy: "dm",
  };
}

function attachmentLink(prompt) {
  const link = prompt.find((block) => block.type === "resource_link");
  assert.ok(link);
  return link;
}

async function startServer(handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

test("same-name attachments use message and instance scoped cache entries", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qqbot-attachments-"));
  const cacheDir = path.join(root, "cache #?%");
  await fs.mkdir(cacheDir);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const contents = [];
  const localPaths = [];
  const agent = {
    async prompt({ prompt }) {
      const link = attachmentLink(prompt);
      assert.equal(link.name, "报告.pdf");
      const localPath = fileURLToPath(link.uri);
      assert.ok(path.resolve(localPath).startsWith(`${path.resolve(cacheDir)}${path.sep}`));
      localPaths.push(localPath);
      contents.push(await fs.readFile(localPath, "utf8"));
      return { stopReason: "end_turn" };
    },
  };
  const bot = new QQBot(
    { app_id: "app", secret: "secret" }, agent, () => {}, cacheDir, "AAG", "actor",
  );

  await bot.dispatchPrompt(context("msg-1", "AAG"), "", [{
    url: "data:text/plain,first",
    content_type: "text/plain",
    filename: "../../报告.pdf",
  }]);
  await bot.dispatchPrompt(context("msg-2", "AAG"), "", [{
    url: "data:text/plain,second",
    content_type: "text/plain",
    filename: "../../报告.pdf",
  }]);

  assert.deepEqual(contents, ["first", "second"]);
  assert.notEqual(localPaths[0], localPaths[1]);

  let secondInstancePath;
  const secondInstance = new QQBot(
    { app_id: "app", secret: "secret" },
    {
      async prompt({ prompt }) {
        const link = attachmentLink(prompt);
        secondInstancePath = fileURLToPath(link.uri);
        assert.equal(await fs.readFile(secondInstancePath, "utf8"), "third");
        return { stopReason: "end_turn" };
      },
    },
    () => {},
    cacheDir,
    "AAa",
    "actor",
  );
  await secondInstance.dispatchPrompt(context("msg-1", "AAa"), "", [{
    url: "data:text/plain,third",
    content_type: "text/plain",
    filename: "../../报告.pdf",
  }]);
  assert.notEqual(secondInstancePath, localPaths[0]);
});

test("concurrent deliveries of one message reuse only a completed cache entry", async (t) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "qqbot-concurrent-"));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const paths = [];
  const bot = new QQBot(
    { app_id: "app", secret: "secret" },
    {
      async prompt({ prompt }) {
        const localPath = fileURLToPath(attachmentLink(prompt).uri);
        assert.equal(await fs.readFile(localPath, "utf8"), "same");
        paths.push(localPath);
        return { stopReason: "end_turn" };
      },
    },
    () => {},
    cacheDir,
    "instance",
    "actor",
  );
  const attachments = [{
    url: "data:text/plain,same",
    content_type: "text/plain",
    filename: "same.txt",
  }];

  await Promise.all([
    bot.dispatchPrompt(context("same-message"), "", attachments),
    bot.dispatchPrompt(context("same-message"), "", attachments),
  ]);

  assert.equal(paths.length, 2);
  assert.equal(paths[0], paths[1]);
  const entries = await fs.readdir(cacheDir, { recursive: true });
  assert.equal(entries.filter((entry) => entry.endsWith(".tmp")).length, 0);
});

test("streams attachments larger than the removed 20 MiB limit", async (t) => {
  const size = 20 * 1024 * 1024 + 1;
  const chunk = Buffer.alloc(64 * 1024, 1);
  const server = await startServer(async (_request, response) => {
    response.writeHead(200, { "content-length": String(size) });
    let remaining = size;
    while (remaining > 0) {
      const current = chunk.subarray(0, Math.min(chunk.length, remaining));
      remaining -= current.length;
      if (!response.write(current)) await once(response, "drain");
    }
    response.end();
  });
  t.after(server.close);
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "qqbot-large-"));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));

  let downloadedSize = 0;
  const bot = new QQBot(
    { app_id: "app", secret: "secret" },
    {
      async prompt({ prompt }) {
        downloadedSize = (await fs.stat(fileURLToPath(attachmentLink(prompt).uri))).size;
        return { stopReason: "end_turn" };
      },
    },
    () => {},
    cacheDir,
    "instance",
    "actor",
  );
  await bot.dispatchPrompt(context("large"), "", [{
    url: server.url,
    content_type: "application/octet-stream",
    filename: "large.bin",
  }]);
  assert.equal(downloadedSize, size);
});

test("failed attachment responses leave no final or temporary file", async (t) => {
  const server = await startServer((request, response) => {
    if (request.url === "/broken") {
      response.writeHead(200, { "content-length": "100" });
      response.write("partial");
      setImmediate(() => response.destroy());
      return;
    }
    response.writeHead(404);
    response.end();
  });
  t.after(server.close);
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "qqbot-failed-"));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  let prompts = 0;
  const bot = new QQBot(
    { app_id: "app", secret: "secret" },
    { async prompt() { prompts += 1; return { stopReason: "end_turn" }; } },
    () => {},
    cacheDir,
    "instance",
    "actor",
  );

  await bot.dispatchPrompt(context("broken"), "", [{ url: `${server.url}/broken`, filename: "x.bin" }]);
  await bot.dispatchPrompt(context("missing"), "", [{ url: `${server.url}/missing`, filename: "x.bin" }]);

  const entries = await fs.readdir(cacheDir, { recursive: true, withFileTypes: true });
  assert.equal(entries.filter((entry) => entry.isFile()).length, 0);
  assert.equal(prompts, 0);
});
