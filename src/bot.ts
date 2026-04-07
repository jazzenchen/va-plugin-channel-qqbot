/**
 * QQBot — wraps qq-guild-bot SDK for QQ Guild bot messaging.
 *
 * Handles:
 *   - WebSocket gateway connection (no public IP)
 *   - DIRECT_MESSAGE (DM) and AT_MESSAGE (channel @mention) intents
 *   - Reply via OpenAPI postMessage / postDirectMessage
 */

import {
  AvailableIntentsEventsEnum,
  createOpenAPI,
  createWebsocket,
  type IMessage,
  type IOpenAPI,
} from "qq-guild-bot";
import type { Agent, ContentBlock } from "@vibearound/plugin-channel-sdk";
import type { AgentStreamHandler } from "./agent-stream.js";

export interface QQBotConfig {
  app_id: string;
  token: string;
}

type LogFn = (level: string, msg: string) => void;

interface PendingContext {
  /** Original message id, used as msg_id (passive reply) */
  msgId: string;
  /** Channel id (guild) or guild id (DM) for the reply target */
  targetId: string;
  /** Whether this is a DM (use directMessageApi.postDirectMessage) */
  isDirect: boolean;
}

export class QQBot {
  private openApi: IOpenAPI;
  // qq-guild-bot's createWebsocket returns a WebsocketClient extending EventEmitter
  private ws: ReturnType<typeof createWebsocket>;
  private agent: Agent;
  private log: LogFn;
  private cacheDir: string;
  private streamHandler: AgentStreamHandler | null = null;
  /** channelId → most recent message context for replies */
  private pending = new Map<string, PendingContext>();

  constructor(config: QQBotConfig, agent: Agent, log: LogFn, cacheDir: string) {
    this.agent = agent;
    this.log = log;
    this.cacheDir = cacheDir;

    const sdkConfig = {
      appID: config.app_id,
      token: config.token,
      intents: [
        AvailableIntentsEventsEnum.DIRECT_MESSAGE,
        AvailableIntentsEventsEnum.PUBLIC_GUILD_MESSAGES,
      ],
      sandbox: false,
    };

    this.openApi = createOpenAPI(sdkConfig);
    this.ws = createWebsocket(sdkConfig);
  }

  setStreamHandler(handler: AgentStreamHandler): void {
    this.streamHandler = handler;
  }

  /** Reply with a passive message (uses msg_id from the inbound message). */
  async sendText(channelId: string, content: string): Promise<void> {
    const ctx = this.pending.get(channelId);
    if (!ctx) {
      this.log("warn", `no pending context for channel=${channelId}, dropping reply`);
      return;
    }
    try {
      if (ctx.isDirect) {
        await this.openApi.directMessageApi.postDirectMessage(ctx.targetId, {
          content,
          msg_id: ctx.msgId,
        });
      } else {
        await this.openApi.messageApi.postMessage(ctx.targetId, {
          content,
          msg_id: ctx.msgId,
        });
      }
    } catch (e) {
      const err = e as { message?: string };
      this.log("error", `sendText failed: ${err.message ?? String(e)}`);
    }
  }

  async start(): Promise<void> {
    // The qq-guild-bot WebsocketClient extends ws.EventEmitter which has on()
    // at runtime but TypeScript types don't expose it cleanly. Cast to a
    // minimal event-emitter shape.
    type EventListener = (data: { eventType: string; msg: IMessage }) => void;
    const wsEmitter = this.ws as unknown as {
      on: (event: string, listener: EventListener) => void;
    };

    // Handle direct messages
    wsEmitter.on(AvailableIntentsEventsEnum.DIRECT_MESSAGE, (data) => {
      void this.handleDirectMessage(data.msg);
    });

    // Handle channel @mention messages
    wsEmitter.on(AvailableIntentsEventsEnum.PUBLIC_GUILD_MESSAGES, (data) => {
      // Only respond to AT_MESSAGE_CREATE (mentions)
      if (data.eventType === "AT_MESSAGE_CREATE") {
        void this.handleAtMessage(data.msg);
      }
    });

    this.log("info", "QQ Bot WebSocket gateway started");
  }

  async stop(): Promise<void> {
    try {
      // qq-guild-bot WebsocketClient doesn't expose a clean close in types,
      // but the underlying ws will be cleaned up on process exit
      const ws = this.ws as unknown as { closeSession?: () => void };
      if (typeof ws.closeSession === "function") {
        ws.closeSession();
      }
    } catch {
      // ignore
    }
  }

  private stripMention(content: string): string {
    // Remove <@!user_id> mention tags
    return content.replace(/<@!?\d+>/g, "").trim();
  }

  private async handleDirectMessage(msg: IMessage): Promise<void> {
    const text = this.stripMention(msg.content ?? "").trim();
    if (!text) return;

    // For DMs, target is the guild_id
    const channelId = `qqbot:dm:${msg.guild_id}`;
    this.pending.set(channelId, {
      msgId: msg.id,
      targetId: msg.guild_id,
      isDirect: true,
    });

    this.log("debug", `dm chat=${channelId} sender=${msg.author?.id} text=${text.slice(0, 80)}`);

    await this.dispatchPrompt(channelId, text);
  }

  private async handleAtMessage(msg: IMessage): Promise<void> {
    const text = this.stripMention(msg.content ?? "").trim();
    if (!text) return;

    // For guild channels, target is the channel_id
    const channelId = `qqbot:channel:${msg.channel_id}`;
    this.pending.set(channelId, {
      msgId: msg.id,
      targetId: msg.channel_id,
      isDirect: false,
    });

    this.log("debug", `at_message chat=${channelId} sender=${msg.author?.id} text=${text.slice(0, 80)}`);

    await this.dispatchPrompt(channelId, text);
  }

  private async dispatchPrompt(channelId: string, text: string): Promise<void> {
    const contentBlocks: ContentBlock[] = [{ type: "text", text }];

    this.streamHandler?.onPromptSent(channelId);

    try {
      const response = await this.agent.prompt({
        sessionId: channelId,
        prompt: contentBlocks,
      });
      this.log("info", `prompt done chat=${channelId} stopReason=${response.stopReason}`);
      this.streamHandler?.onTurnEnd(channelId);
    } catch (error: unknown) {
      const errMsg =
        error instanceof Error
          ? error.message
          : typeof error === "object" && error !== null && "message" in error
            ? String((error as { message: unknown }).message)
            : String(error);
      this.log("error", `prompt failed chat=${channelId}: ${errMsg}`);
      this.streamHandler?.onTurnError(channelId, errMsg);
    }
  }
}
