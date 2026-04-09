/**
 * AgentStreamHandler — receives ACP session updates from the Host and renders
 * them as QQ Bot text messages.
 *
 * QQ Guild messages do not support editing, so each block is sent as a new message.
 * Passive replies (using msg_id) are required for guild channels.
 */

import {
  BlockRenderer,
  type BlockKind,
  type VerboseConfig,
} from "@vibearound/plugin-channel-sdk";
import type { QQBot } from "./bot.js";

type LogFn = (level: string, msg: string) => void;

export class AgentStreamHandler extends BlockRenderer<string> {
  private qqBot: QQBot;
  private log: LogFn;
  private lastChannelId: string | null = null;

  constructor(qqBot: QQBot, log: LogFn, verbose?: Partial<VerboseConfig>) {
    super({
      flushIntervalMs: 800,
      // QQ Bot has no edit support — high min edit interval prevents thrashing
      minEditIntervalMs: 60_000,
      verbose,
    });
    this.qqBot = qqBot;
    this.log = log;
  }

  protected formatContent(kind: BlockKind, content: string, _sealed: boolean): string {
    switch (kind) {
      case "thinking":
        return `💭 ${content}`;
      case "tool":
        return `[tool] ${content.trim()}`;
      case "text":
        return content;
    }
  }

  /** Send a new message via QQ Bot OpenAPI. Returns null (no edit support). */
  protected async sendBlock(
    channelId: string,
    _kind: BlockKind,
    content: string,
  ): Promise<string | null> {
    await this.qqBot.sendText(channelId, content);
    return null;
  }

  // Intentionally do NOT override `editBlock`: QQ has no edit primitive, and
  // leaving it undefined lets BlockRenderer.flush() detect send-only mode
  // and defer intermediate debounced flushes until onTurnEnd seals the
  // block. Otherwise the user would see the partial first-flush send AND
  // the final sealed send as two separate messages.

  protected async onAfterTurnEnd(channelId: string): Promise<void> {
    this.log("debug", `turn_complete session=${channelId}`);
  }

  protected async onAfterTurnError(channelId: string, error: string): Promise<void> {
    await this.qqBot.sendText(channelId, `❌ Error: ${error}`);
  }

  onPromptSent(channelId: string): void {
    this.lastChannelId = channelId;
    super.onPromptSent(channelId);
  }

  onAgentReady(agent: string, version: string): void {
    if (this.lastChannelId) {
      this.qqBot.sendText(this.lastChannelId, `🤖 Agent: ${agent} v${version}`).catch(() => {});
    }
  }

  onSessionReady(sessionId: string): void {
    if (this.lastChannelId) {
      this.qqBot.sendText(this.lastChannelId, `📋 Session: ${sessionId}`).catch(() => {});
    }
  }

  onSystemText(text: string): void {
    if (this.lastChannelId) {
      this.qqBot.sendText(this.lastChannelId, text).catch(() => {});
    }
  }
}
