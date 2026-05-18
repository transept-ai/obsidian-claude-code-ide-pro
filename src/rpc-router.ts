// JSON-RPC 2.0 routing with no transport knowledge.
// Transports (ws-server.ts) call handle() per inbound message and write the
// (possibly null) response back over their own wire.

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: JsonValue;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: JsonValue;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: JsonValue;
}

export type RpcHandler = (
  params: JsonValue | undefined,
) => Promise<JsonValue> | JsonValue;

export const RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export class RpcRouter {
  private handlers = new Map<string, RpcHandler>();

  register(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  has(method: string): boolean {
    return this.handlers.has(method);
  }

  methods(): string[] {
    return [...this.handlers.keys()];
  }

  // Returns the response to send, or null for notifications (no id).
  async handle(raw: string): Promise<JsonRpcResponse | null> {
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(raw);
    } catch {
      return errorResponse(null, RPC_ERRORS.parseError, "Parse error");
    }

    if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return errorResponse(
        msg.id ?? null,
        RPC_ERRORS.invalidRequest,
        "Invalid request",
      );
    }

    const isNotification = msg.id === undefined;
    const handler = this.handlers.get(msg.method);
    if (!handler) {
      if (isNotification) return null;
      return errorResponse(
        msg.id ?? null,
        RPC_ERRORS.methodNotFound,
        `Method not found: ${msg.method}`,
      );
    }

    try {
      const result = await handler(msg.params);
      if (isNotification) return null;
      return {
        jsonrpc: "2.0",
        id: msg.id ?? null,
        result: result ?? null,
      };
    } catch (err) {
      if (isNotification) return null;
      const message =
        err instanceof Error ? err.message : "Internal handler error";
      const data: JsonValue =
        err instanceof Error && err.stack ? { stack: err.stack } : null;
      return errorResponse(
        msg.id ?? null,
        RPC_ERRORS.internalError,
        message,
        data,
      );
    }
  }
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: JsonValue,
): JsonRpcResponse {
  const error: JsonRpcError = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

export function buildNotification(
  method: string,
  params?: JsonValue,
): string {
  const payload: JsonRpcRequest = { jsonrpc: "2.0", method };
  if (params !== undefined) payload.params = params;
  return JSON.stringify(payload);
}
