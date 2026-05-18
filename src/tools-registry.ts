import type { JsonValue } from "./rpc-router";

export interface ToolInputSchema {
  type: "object";
  properties?: Record<string, JsonValue>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

export type ToolArgs = Record<string, JsonValue> | undefined;

export type ToolHandler = (
  args: ToolArgs,
) => Promise<JsonValue> | JsonValue;

interface ToolEntry {
  desc: ToolDescriptor;
  handler: ToolHandler;
}

// Tracks all MCP tools exposed via tools/list and tools/call.
// Standard Claude Code IDE tools (openFile, getCurrentSelection, ...) and
// custom Obsidian tools (getBacklinks, ...) are both registered here.
export class ToolRegistry {
  private tools = new Map<string, ToolEntry>();

  register(desc: ToolDescriptor, handler: ToolHandler): void {
    this.tools.set(desc.name, { desc, handler });
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDescriptor[] {
    return [...this.tools.values()].map((e) => e.desc);
  }

  async call(name: string, args: ToolArgs): Promise<JsonValue> {
    const entry = this.tools.get(name);
    if (!entry) throw new ToolNotFoundError(name);
    return await entry.handler(args);
  }
}

export class ToolNotFoundError extends Error {
  constructor(public readonly toolName: string) {
    super(`Tool not found: ${toolName}`);
    this.name = "ToolNotFoundError";
  }
}
