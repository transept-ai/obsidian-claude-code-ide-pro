import type { ToolRegistry } from "../tools-registry";
import { asJson } from "../obsidian-context";

// Tools the protocol expects but that have no meaningful Obsidian behavior.
// We return well-formed empty results / explicit unsupported errors so
// Claude Code doesn't retry or treat them as transport failures.
export function registerStubTools(tools: ToolRegistry): void {
  tools.register(
    {
      name: "getDiagnostics",
      description:
        "Return LSP-style diagnostics. Obsidian has no LSP, so this is always empty.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: true,
      },
    },
    () => asJson([]),
  );

  tools.register(
    {
      name: "executeCode",
      description:
        "Execute code in a kernel. Obsidian has no Jupyter integration.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: true,
      },
    },
    () =>
      asJson({
        success: false,
        message: "executeCode is not supported in Obsidian (no Jupyter kernel).",
      }),
  );

}
