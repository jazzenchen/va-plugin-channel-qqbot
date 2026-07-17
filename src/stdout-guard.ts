/**
 * stdout-guard.ts — MUST be the first import in main.ts.
 *
 * Intercepts process.stdout.write so that only JSON lines (starting with '{')
 * pass through. Everything else is discarded because upstream diagnostics can
 * contain credentials, signed URLs, request bodies, and user content.
 *
 * This prevents SDK console output from polluting the ACP JSON-RPC channel or
 * being persisted by the host's stderr capture.
 */

import { isProtocolStdoutLine } from "./log-policy.js";

const _origWrite = process.stdout.write.bind(process.stdout);

interface StdoutWrite {
  (chunk: string | Uint8Array | Buffer, ...args: unknown[]): boolean;
}

const guarded: StdoutWrite = function (chunk, ..._args) {
  const str =
    typeof chunk === "string"
      ? chunk
      : Buffer.isBuffer(chunk) || chunk instanceof Uint8Array
        ? Buffer.from(chunk).toString("utf-8")
        : String(chunk);

  for (const line of str.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (isProtocolStdoutLine(trimmed)) {
      // JSON line — pass through
      _origWrite(line + "\n");
    }
  }
  return true;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(process.stdout as any).write = guarded;
