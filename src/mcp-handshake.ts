import { RpcRouter, JsonValue } from "./rpc-router";
import { ToolRegistry, ToolNotFoundError } from "./tools-registry";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "Claude Code IDE (Obsidian)";
const SERVER_VERSION = "0.1.0";

// Registers the four MCP framing methods every IDE host must respond to:
//   initialize, notifications/initialized, tools/list, tools/call
// Tool *behavior* is added separately via ToolRegistry.
export function registerMcpHandshake(
  router: RpcRouter,
  tools: ToolRegistry,
): void {
  router.register("initialize", async () => ({
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  }));

  router.register("notifications/initialized", async () => null);
  router.register("notifications/cancelled", async () => null);

  router.register("tools/list", async () => ({
    tools: tools.list() as unknown as JsonValue,
  }));

  router.register("tools/call", async (params) => {
    const p = (params ?? {}) as {
      name?: string;
      arguments?: Record<string, JsonValue>;
    };
    if (typeof p.name !== "string") {
      throw new Error("tools/call: missing 'name'");
    }
    try {
      const result = await tools.call(p.name, p.arguments);
      // If the tool returned a pre-built MCP content envelope (i.e. an
      // object with a `content` array of `{type, text}` blocks), pass it
      // through verbatim. This is required for openDiff, which must emit a
      // two-element array — Claude Code reads content[1].text as the final
      // file contents on Accept. Re-wrapping would JSON.stringify the
      // whole envelope into a single text block and the CLI would fall
      // back to its own Edit approval flow.
      if (isPrebuiltMcpResult(result)) {
        return result as JsonValue;
      }
      const text =
        typeof result === "string" ? result : JSON.stringify(result);
      const ok: JsonValue = {
        content: [{ type: "text", text }],
      };
      return ok;
    } catch (err) {
      const message =
        err instanceof ToolNotFoundError
          ? `Tool not found: ${err.toolName}`
          : err instanceof Error
            ? err.message
            : String(err);
      const fail: JsonValue = {
        content: [{ type: "text", text: message }],
        isError: true,
      };
      return fail;
    }
  });
}

function isPrebuiltMcpResult(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const r = v as { content?: unknown };
  if (!Array.isArray(r.content) || r.content.length === 0) return false;
  return r.content.every(
    (c) =>
      c !== null &&
      typeof c === "object" &&
      (c as { type?: unknown }).type === "text" &&
      typeof (c as { text?: unknown }).text === "string",
  );
}
