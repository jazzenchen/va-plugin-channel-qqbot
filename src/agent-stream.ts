/**
 * QQ Bot stream renderer — send-only (QQ does not support editing messages).
 */

import {
  BlockRenderer,
  type BlockKind,
  type ChannelTarget,
  type OutboundFile,
  type VerboseConfig,
} from "@vibearound/plugin-channel-sdk";
import type { QQBot } from "./bot.js";

type LogFn = (level: string, msg: string) => void;

export class AgentStreamHandler extends BlockRenderer<string> {
  private qqBot: QQBot;
  private log: LogFn;

  constructor(qqBot: QQBot, log: LogFn, verbose?: Partial<VerboseConfig>) {
    super({
      streaming: false,
      flushIntervalMs: 800,
      verbose,
    });
    this.qqBot = qqBot;
    this.log = log;
  }

  protected async sendText(target: ChannelTarget, text: string): Promise<void> {
    await this.qqBot.sendText(target, text);
  }

  protected async sendFile(
    target: ChannelTarget,
    file: OutboundFile,
  ): Promise<void> {
    await this.qqBot.sendFile(target, file);
  }

  protected formatContent(kind: BlockKind, content: string, _sealed: boolean): string {
    switch (kind) {
      case "thinking": return `💭 ${content}`;
      case "tool":     return `[tool] ${content.trim()}`;
      case "text":     return content;
    }
  }

  protected async sendBlock(target: ChannelTarget, _kind: BlockKind, content: string): Promise<string | null> {
    await this.qqBot.sendText(target, content);
    return null;
  }
}
