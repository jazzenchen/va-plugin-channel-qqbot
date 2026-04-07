/**
 * stdout-guard.ts — MUST be the first import in main.ts.
 *
 * Intercepts process.stdout.write so that only JSON lines (starting with '{')
 * pass through. Everything else is redirected to stderr.
 *
 * This prevents the qq-guild-bot SDK's loglevel/console.log output from
 * polluting the ACP JSON-RPC channel, which would otherwise crash the plugin.
 */

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
    if (trimmed.startsWith("{")) {
      // JSON line — pass through
      _origWrite(line + "\n");
    } else {
      process.stderr.write("[stdout-guard] " + line + "\n");
    }
  }
  return true;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(process.stdout as any).write = guarded;
