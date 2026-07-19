/**
 * QQBot — wraps the QQ Bot v2 platform (q.qq.com / 开放平台).
 *
 * Uses Tencent's official `@tencent-connect/openclaw-qqbot` package for the
 * authenticated HTTP APIs (token fetch, gateway URL fetch, message sending),
 * and implements a minimal custom WebSocket loop with `ws` for the gateway.
 *
 * Why not use that package's `startGateway()` directly? It's tightly coupled
 * to OpenClaw's plugin SDK runtime types. We bypass it and use only the pure
 * api functions, which have no openclaw dependencies.
 *
 * Auth flow:
 *   1. POST https://bots.qq.com/app/getAppAccessToken { appId, clientSecret } → access_token
 *   2. GET https://api.sgroup.qq.com/v2/gateway/bot → wss URL
 *   3. WebSocket connect → receive HELLO (op=10)
 *   4. Send IDENTIFY (op=2) with token + intents
 *   5. Receive READY (op=0, t="READY")
 *   6. Heartbeat (op=1) every heartbeat_interval ms
 *   7. Handle dispatch events (op=0): C2C_MESSAGE_CREATE, GROUP_AT_MESSAGE_CREATE, etc.
 */

import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pathToFileURL } from "node:url";
import {
  getAccessToken,
  getGatewayUrl,
  sendC2CMessage,
  sendGroupMessage,
  sendChannelMessage,
  sendDmMessage,
  setApiLogger,
} from "@tencent-connect/openclaw-qqbot/dist/src/api.js";
import WebSocket from "ws";
import {
  cancelChannelPrompt,
  channelTargetFromInboundContext,
  extractErrorMessage,
  isChannelStopCommand,
  sendChannelPrompt,
} from "@vibearound/plugin-channel-sdk";
import type { Agent, ChannelInboundContext, ChannelTarget, ContentBlock } from "@vibearound/plugin-channel-sdk";
import type { AgentStreamHandler } from "./agent-stream.js";
import { safeErrorCategory, SILENT_UPSTREAM_LOGGER } from "./log-policy.js";

interface DownloadedAttachment {
  readonly path: string;
  readonly mimeType: string;
  readonly displayName: string;
}

export interface QQBotConfig {
  app_id: string;
  /** AppSecret from QQ Open Platform. Accepts either the raw secret or "appid:secret". */
  secret: string;
}

type LogFn = (level: string, msg: string) => void;

// QQ Bot intents — bit flags from openclaw-qqbot gateway.js:274
const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C: 1 << 25,
  INTERACTION: 1 << 26,
};
const FULL_INTENTS =
  INTENTS.PUBLIC_GUILD_MESSAGES |
  INTENTS.DIRECT_MESSAGE |
  INTENTS.GROUP_AND_C2C |
  INTENTS.INTERACTION;

interface PendingContext {
  /** Original inbound message id (used as msg_id for passive replies). */
  msgId: string;
  /** Reply target identifier (varies by chat type). */
  target: string;
  /** Chat kind. */
  kind: "c2c" | "group" | "channel" | "dm";
}

interface DispatchAuthor {
  id?: string;
  username?: string;
  user_openid?: string;
  member_openid?: string;
}

interface DispatchAttachment {
  /** e.g. "image/jpeg", "voice/silk", "application/octet-stream" */
  content_type?: string;
  /** Short-lived signed URL from QQ CDN — no auth needed to fetch. */
  url?: string;
  filename?: string;
  /** Voice ASR transcript (QQ-provided). */
  asr_refer_text?: string;
}

interface DispatchEvent {
  id: string;
  content?: string;
  author?: DispatchAuthor;
  channel_id?: string;
  guild_id?: string;
  group_openid?: string;
  /** Rich-media attachments (images, voice, files). Missing when text-only. */
  attachments?: DispatchAttachment[];
}

export class QQBot {
  private appId: string;
  private clientSecret: string;
  private agent: Agent;
  private log: LogFn;
  private cacheDir: string;
  private channelInstanceId: string;
  private actorId: string;
  private streamHandler: AgentStreamHandler | null = null;

  private accessToken: string | null = null;
  private ws: WebSocket | null = null;

  /** Heartbeat check — gateway ws must be open for inbound events to arrive. */
  public isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private awaitingHeartbeatAck = false;
  private lastSeq: number | null = null;
  private sessionId: string | null = null;
  private reconnectAttempts = 0;
  private stopped = false;

  /** chatId → context for the most recent inbound message. */
  private pending = new Map<string, PendingContext>();

  constructor(
    config: QQBotConfig,
    agent: Agent,
    log: LogFn,
    cacheDir: string,
    channelInstanceId: string,
    actorId: string,
  ) {
    this.agent = agent;
    this.log = log;
    this.cacheDir = cacheDir;
    this.channelInstanceId = channelInstanceId;
    this.actorId = actorId;
    this.appId = config.app_id;

    // Accept either raw secret or "appid:secret" combined format
    const rawSecret = config.secret;
    if (rawSecret.includes(":")) {
      const [, secretPart] = rawSecret.split(":", 2);
      this.clientSecret = secretPart;
    } else {
      this.clientSecret = rawSecret;
    }

    setApiLogger(SILENT_UPSTREAM_LOGGER);
  }

  setStreamHandler(handler: AgentStreamHandler): void {
    this.streamHandler = handler;
  }

  /** Get a fresh access token. The API helper owns expiry-aware caching. */
  private async ensureToken(): Promise<string> {
    this.accessToken = await getAccessToken(this.appId, this.clientSecret);
    return this.accessToken;
  }

  async sendText(target: ChannelTarget, content: string): Promise<void> {
    const ctx = target.replyTo ? this.pending.get(target.replyTo) : undefined;
    if (!ctx) {
      this.log("warn", "sendText failed category=missing_context");
      throw new Error("QQ reply context is unavailable");
    }
    try {
      const token = await this.ensureToken();
      switch (ctx.kind) {
        case "c2c":
          await sendC2CMessage(token, ctx.target, content, ctx.msgId);
          break;
        case "group":
          await sendGroupMessage(token, ctx.target, content, ctx.msgId);
          break;
        case "channel":
          await sendChannelMessage(token, ctx.target, content, ctx.msgId);
          break;
        case "dm":
          await sendDmMessage(token, ctx.target, content, ctx.msgId);
          break;
      }
    } catch (error: unknown) {
      this.log("error", `sendText failed category=${safeErrorCategory(error)}`);
      throw error;
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private async connect(): Promise<void> {
    try {
      const token = await this.ensureToken();
      const gatewayUrl = await getGatewayUrl(token);
      this.log("info", "QQ Bot connecting to gateway");

      const ws = new WebSocket(gatewayUrl);
      this.ws = ws;

      ws.on("open", () => {
        this.log("info", "QQ Bot WebSocket open, waiting for HELLO");
      });

      ws.on("message", (data) => {
        try {
          this.handleFrame(JSON.parse(data.toString()));
        } catch {
          this.log("error", "failed to parse gateway frame");
        }
      });

      ws.on("close", (code) => {
        this.log("warn", `QQ Bot WebSocket closed: code=${code}`);
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        this.awaitingHeartbeatAck = false;
        if (!this.stopped) {
          this.scheduleReconnect();
        }
      });

      ws.on("error", (error) => {
        this.log("error", `QQ Bot WebSocket error category=${safeErrorCategory(error)}`);
      });
    } catch (error: unknown) {
      this.log("error", `QQ Bot connect failed category=${safeErrorCategory(error)}`);
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    }
  }

  private scheduleReconnect(): void {
    const delays = [1000, 2000, 5000, 10000, 30000, 60000];
    const delay = delays[Math.min(this.reconnectAttempts, delays.length - 1)];
    this.reconnectAttempts++;
    this.log("info", `QQ Bot reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => {
      if (!this.stopped) void this.connect();
    }, delay);
  }

  private handleFrame(frame: { op: number; d?: unknown; s?: number; t?: string }): void {
    const { op, d, s, t } = frame;

    if (typeof s === "number") {
      this.lastSeq = s;
    }

    switch (op) {
      case 10: {
        // HELLO — send IDENTIFY and start heartbeat
        const helloData = (d ?? {}) as { heartbeat_interval?: number };
        const interval = helloData.heartbeat_interval ?? 30000;

        // Send IDENTIFY
        if (this.accessToken) {
          this.ws?.send(
            JSON.stringify({
              op: 2,
              d: {
                token: `QQBot ${this.accessToken}`,
                intents: FULL_INTENTS,
                shard: [0, 1],
              },
            }),
          );
          this.log("info", `QQ Bot sent IDENTIFY (intents=${FULL_INTENTS})`);
        }

        // Start heartbeat
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.awaitingHeartbeatAck = false;
        this.heartbeatTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            if (this.awaitingHeartbeatAck) {
              this.log("warn", "QQ Bot heartbeat ACK timed out; reconnecting");
              this.ws.terminate();
              return;
            }
            this.ws.send(JSON.stringify({ op: 1, d: this.lastSeq }));
            this.awaitingHeartbeatAck = true;
          }
        }, interval);
        break;
      }

      case 0: {
        // DISPATCH
        switch (t) {
          case "READY": {
            const readyData = (d ?? {}) as { session_id?: string };
            this.sessionId = readyData.session_id ?? null;
            this.reconnectAttempts = 0;
            this.log("info", "QQ Bot READY");
            break;
          }
          case "C2C_MESSAGE_CREATE":
            void this.handleC2CMessage(d as DispatchEvent).catch((error: unknown) => {
              this.log("error", `inbound message handling failed category=${safeErrorCategory(error)}`);
            });
            break;
          case "AT_MESSAGE_CREATE":
            void this.handleAtMessage(d as DispatchEvent).catch((error: unknown) => {
              this.log("error", `inbound message handling failed category=${safeErrorCategory(error)}`);
            });
            break;
          case "DIRECT_MESSAGE_CREATE":
            void this.handleDmMessage(d as DispatchEvent).catch((error: unknown) => {
              this.log("error", `inbound message handling failed category=${safeErrorCategory(error)}`);
            });
            break;
          case "GROUP_AT_MESSAGE_CREATE":
            void this.handleGroupAtMessage(d as DispatchEvent).catch((error: unknown) => {
              this.log("error", `inbound message handling failed category=${safeErrorCategory(error)}`);
            });
            break;
          default:
            this.log("debug", "QQ Bot unsupported dispatch ignored");
        }
        break;
      }

      case 11: // Heartbeat ACK
        this.awaitingHeartbeatAck = false;
        break;

      default:
        this.log("debug", "QQ Bot unsupported frame ignored");
    }
  }

  private stripMention(content: string): string {
    return content.replace(/<@!?\d+>/g, "").trim();
  }

  private async handleC2CMessage(event: DispatchEvent): Promise<void> {
    const text = this.stripMention(event.content ?? "");
    const senderOpenid = event.author?.user_openid;
    if (!senderOpenid) return;
    if (!text && !event.attachments?.length) return;

    const chatId = `c2c:${senderOpenid}`;
    this.pending.set(event.id, { msgId: event.id, target: senderOpenid, kind: "c2c" });
    this.log("debug", `QQ Bot inbound c2c has_attachments=${Boolean(event.attachments?.length)}`);
    await this.dispatchPrompt({
      channelInstanceId: this.channelInstanceId,
      actorId: this.actorId,
      chatId,
      senderId: event.author?.user_openid ?? event.author?.id,
      platformMessageId: event.id,
      scope: "dm",
      addressedBy: "dm",
    }, text, event.attachments);
  }

  private async handleGroupAtMessage(event: DispatchEvent): Promise<void> {
    const text = this.stripMention(event.content ?? "");
    const groupOpenid = event.group_openid;
    if (!groupOpenid) return;
    if (!text && !event.attachments?.length) return;

    const chatId = `group:${groupOpenid}`;
    this.pending.set(event.id, { msgId: event.id, target: groupOpenid, kind: "group" });
    this.log("debug", `QQ Bot inbound group has_attachments=${Boolean(event.attachments?.length)}`);
    await this.dispatchPrompt({
      channelInstanceId: this.channelInstanceId,
      actorId: this.actorId,
      chatId,
      senderId: event.author?.member_openid ?? event.author?.id,
      platformMessageId: event.id,
      scope: "group",
      addressedBy: "mention",
    }, text, event.attachments);
  }

  private async handleAtMessage(event: DispatchEvent): Promise<void> {
    const text = this.stripMention(event.content ?? "");
    const channelId = event.channel_id;
    if (!channelId) return;
    if (!text && !event.attachments?.length) return;

    const chatId = `channel:${channelId}`;
    this.pending.set(event.id, { msgId: event.id, target: channelId, kind: "channel" });
    this.log("debug", `QQ Bot inbound channel has_attachments=${Boolean(event.attachments?.length)}`);
    await this.dispatchPrompt({
      channelInstanceId: this.channelInstanceId,
      actorId: this.actorId,
      chatId,
      senderId: event.author?.id,
      platformMessageId: event.id,
      scope: "group",
      addressedBy: "mention",
    }, text, event.attachments);
  }

  private async handleDmMessage(event: DispatchEvent): Promise<void> {
    const text = this.stripMention(event.content ?? "");
    const guildId = event.guild_id;
    if (!guildId) return;
    if (!text && !event.attachments?.length) return;

    const chatId = `dm:${guildId}`;
    this.pending.set(event.id, { msgId: event.id, target: guildId, kind: "dm" });
    this.log("debug", `QQ Bot inbound dm has_attachments=${Boolean(event.attachments?.length)}`);
    await this.dispatchPrompt({
      channelInstanceId: this.channelInstanceId,
      actorId: this.actorId,
      chatId,
      senderId: event.author?.id,
      platformMessageId: event.id,
      scope: "dm",
      addressedBy: "dm",
    }, text, event.attachments);
  }

  private async dispatchPrompt(
    inboundContext: ChannelInboundContext,
    text: string,
    attachments?: DispatchAttachment[],
  ): Promise<void> {
    const { chatId } = inboundContext;
    const target = channelTargetFromInboundContext(inboundContext);
    if (text && isChannelStopCommand(text)) {
      await cancelChannelPrompt(this.agent, { context: inboundContext });
      if (target.replyTo) this.pending.delete(target.replyTo);
      return;
    }

    const contentBlocks: ContentBlock[] = [];

    if (text) {
      contentBlocks.push({ type: "text", text });
    }

    const downloaded: DownloadedAttachment[] = [];
    const messageId = inboundContext.platformMessageId;
    if (!messageId?.trim() && (attachments ?? []).some((attachment) => attachment.url)) {
      this.log("warn", "attachments dropped because the inbound message id is missing");
    } else if (messageId) {
      for (const [index, attachment] of (attachments ?? []).entries()) {
        if (!attachment.url) continue;
        const local = await this.downloadAttachment(chatId, messageId, index, attachment).catch(
          (err: unknown) => {
            this.log("warn", `attachment download failed category=${safeErrorCategory(err)}`);
            return null;
          },
        );
        if (local) downloaded.push(local);
      }
    }

    if (!text && downloaded.length > 0) {
      contentBlocks.push({
        type: "text",
        text: `The user sent ${downloaded.length} file${downloaded.length > 1 ? "s" : ""}.`,
      });
    }

    for (const file of downloaded) {
      contentBlocks.push({
        type: "resource_link",
        uri: pathToFileURL(file.path).href,
        name: file.displayName,
        mimeType: file.mimeType,
      });
    }

    if (contentBlocks.length === 0) {
      if (target.replyTo) this.pending.delete(target.replyTo);
      return;
    }

    const firstText = contentBlocks[0]?.type === "text" ? contentBlocks[0].text : "";
    if (firstText && this.streamHandler?.consumePendingText(target, firstText)) {
      if (target.replyTo) this.pending.delete(target.replyTo);
      return;
    }

    this.streamHandler?.onPromptSent(target);

    try {
      const response = await sendChannelPrompt(this.agent, {
        context: inboundContext,
        prompt: contentBlocks,
      });
      if (!response) {
        await this.streamHandler?.onTurnEnd(target);
        return;
      }
      this.log("info", "prompt completed");
      await this.streamHandler?.onTurnEnd(target);
    } catch (error: unknown) {
      const errMsg = extractErrorMessage(error);
      this.log("error", `prompt failed category=${safeErrorCategory(error)}`);
      await this.streamHandler?.onTurnError(target, errMsg);
    } finally {
      if (target.replyTo) this.pending.delete(target.replyTo);
    }
  }

  /**
   * Download a QQ attachment into the plugin cache. Entries are scoped by
   * plugin instance, chat, message, and attachment index.
   */
  private async downloadAttachment(
    chatId: string,
    messageId: string,
    index: number,
    attachment: DispatchAttachment,
  ): Promise<DownloadedAttachment> {
    const rawUrl = attachment.url!;
    const url = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
    const contentType = attachment.content_type ?? "application/octet-stream";

    const dir = path.join(
      this.cacheDir,
      "qqbot",
      fileSystemKey(this.channelInstanceId),
      fileSystemKey(chatId),
    );

    // Preserve the platform filename for display, but use a sanitized cache
    // key on disk. Signed URL query strings are excluded.
    const urlPath = (() => {
      try {
        return new URL(url).pathname;
      } catch {
        return url;
      }
    })();
    const baseFromUrl = path.posix.basename(urlPath);
    const supplied = path.posix.basename((attachment.filename ?? "").replaceAll("\\", "/")).trim();
    const displayName = supplied || baseFromUrl || "attachment";
    const fileName = buildAttachmentStorageFileName(messageId, index);
    const localPath = path.join(dir, fileName);

    try {
      await fs.access(localPath);
      this.log("debug", "QQ Bot attachment cache hit");
      return { path: localPath, mimeType: contentType, displayName };
    } catch {
      // not cached
    }

    this.log("debug", "QQ Bot attachment download started");
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching attachment`);
    }
    await fs.mkdir(dir, { recursive: true });
    const temporaryPath = path.join(dir, `.${randomUUID()}.tmp`);
    try {
      if (res.body) {
        await pipeline(
          Readable.fromWeb(res.body as NodeReadableStream),
          createWriteStream(temporaryPath),
        );
      } else {
        await fs.writeFile(temporaryPath, new Uint8Array());
      }
      try {
        await fs.rename(temporaryPath, localPath);
      } catch (error) {
        try {
          await fs.access(localPath);
        } catch {
          throw error;
        }
      }
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
    this.log("debug", "QQ Bot attachment cached");

    return { path: localPath, mimeType: contentType, displayName };
  }
}

function buildAttachmentStorageFileName(
  messageId: string,
  index: number,
): string {
  return `${fileSystemKey(messageId)}-${index}`;
}

function fileSystemKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
