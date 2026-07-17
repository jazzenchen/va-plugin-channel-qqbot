export interface UpstreamLogger {
  info(message: string): void;
  error(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

const ignoreUpstreamMessage = (_message: string): void => {};

/**
 * Tencent's API helper logs credentials, request bodies, response bodies, and
 * raw errors. The adapter emits its own bounded lifecycle logs instead.
 */
export const SILENT_UPSTREAM_LOGGER: UpstreamLogger = Object.freeze({
  info: ignoreUpstreamMessage,
  error: ignoreUpstreamMessage,
  warn: ignoreUpstreamMessage,
  debug: ignoreUpstreamMessage,
});

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

const TIMEOUT_ERROR_CODES = new Set(["ETIMEDOUT", "ESOCKETTIMEDOUT"]);

/** Return a finite diagnostic category without copying attacker-controlled text. */
export function safeErrorCategory(error: unknown): string {
  if (typeof error !== "object" || error === null) return "unknown";
  const value = error as { name?: unknown; code?: unknown; status?: unknown };
  if (value.name === "AbortError") return "timeout";
  if (typeof value.status === "number" && Number.isInteger(value.status)) {
    if (value.status >= 400 && value.status <= 599) return `http_${value.status}`;
  }
  if (typeof value.code === "string") {
    if (TIMEOUT_ERROR_CODES.has(value.code)) return "timeout";
    if (NETWORK_ERROR_CODES.has(value.code)) return "network";
  }
  if (value.name === "ApiError") return "api";
  return "unknown";
}

export function isProtocolStdoutLine(line: string): boolean {
  try {
    const value = JSON.parse(line) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const message = value as Record<string, unknown>;
    if (message.jsonrpc !== "2.0") return false;
    if (typeof message.method === "string") return true;
    return Object.hasOwn(message, "id") &&
      (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"));
  } catch {
    return false;
  }
}
