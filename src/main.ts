#!/usr/bin/env node
/**
 * VibeAround QQ Bot Plugin — ACP Client
 *
 * Spawned by the Rust host as a child process.
 * Communicates via ACP protocol (JSON-RPC 2.0 over stdio).
 *
 * QQ Guild Bot uses WebSocket gateway — no public IP required.
 */

import os from "node:os";
import path from "node:path";
import {
  connectToHost,
  normalizeExtMethod,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@vibearound/plugin-channel-sdk";

import { QQBot } from "./bot.js";
import { AgentStreamHandler } from "./agent-stream.js";

let streamHandler: AgentStreamHandler | null = null;

function log(level: string, msg: string): void {
  process.stderr.write(`[qqbot-plugin][${level}] ${msg}\n`);
}

async function start(): Promise<void> {
  log("info", "initializing ACP connection...");

  const { agent, meta, agentInfo, conn } = await connectToHost(
    { name: "vibearound-qqbot", version: "0.1.0" },
    (_a) => ({
      async sessionUpdate(params: SessionNotification): Promise<void> {
        streamHandler?.onSessionUpdate(params);
      },

      async requestPermission(
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        const first = params.options?.[0];
        if (first) {
          return { outcome: { outcome: "selected", optionId: first.optionId } };
        }
        throw new Error("No permission options provided");
      },

      async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
        switch (normalizeExtMethod(method)) {
          case "channel/system_text": {
            const text = params.text as string;
            streamHandler?.onSystemText(text);
            break;
          }
          case "channel/agent_ready": {
            const agentName = params.agent as string;
            const version = params.version as string;
            log("info", `agent_ready: ${agentName} v${version}`);
            streamHandler?.onAgentReady(agentName, version);
            break;
          }
          case "channel/session_ready": {
            const sessionId = params.sessionId as string;
            log("info", `session_ready: ${sessionId}`);
            streamHandler?.onSessionReady(sessionId);
            break;
          }
          default:
            log("warn", `unhandled ext_notification: ${method}`);
        }
      },
    }),
  );

  const config = meta.config;
  const appId = config.app_id as string;
  const token = config.token as string;
  const cacheDir = meta.cacheDir ?? path.join(os.homedir(), ".vibearound", ".cache");

  if (!appId) {
    throw new Error("app_id is required in QQ Bot config");
  }
  if (!token) {
    throw new Error("token is required in QQ Bot config");
  }

  log("info", `initialized, host=${agentInfo.name ?? "unknown"} cacheDir=${cacheDir}`);

  // Create QQ bot
  const qqBot = new QQBot({ app_id: appId, token }, agent, log, cacheDir);

  // Parse verbose config
  const verbose = (config as unknown as Record<string, unknown>).verbose as
    | { show_thinking?: boolean; show_tool_use?: boolean }
    | undefined;

  // Create stream handler
  streamHandler = new AgentStreamHandler(qqBot, log, {
    showThinking: verbose?.show_thinking ?? false,
    showToolUse: verbose?.show_tool_use ?? false,
  });
  qqBot.setStreamHandler(streamHandler);

  // Start the bot
  await qqBot.start();
  log("info", "plugin started");

  // Wait for connection to close
  await conn.closed;
  log("info", "connection closed, shutting down");
  await qqBot.stop();
  process.exit(0);
}

start().catch((error) => {
  log("error", `fatal: ${error}`);
  process.exit(1);
});
