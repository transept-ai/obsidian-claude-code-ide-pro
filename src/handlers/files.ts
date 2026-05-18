import type { ToolRegistry } from "../tools-registry";
import { ObsidianContext, asJson } from "../obsidian-context";
import type { JsonValue } from "../rpc-router";

// File-opening operations. openFile is the workhorse — it's how Claude
// "shows you" a file instead of printing a clickable path.
export function registerFileTools(
  tools: ToolRegistry,
  ctx: ObsidianContext,
): void {
  tools.register(
    {
      name: "openFile",
      description:
        "Open a file in Obsidian, optionally scrolling to a specific line.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Absolute or vault-relative path to the file",
          } as unknown as JsonValue,
          // Match the VS Code openFile param set so Claude Code's
          // existing serializers don't need any adaptation.
          preview: {
            type: "boolean",
            description: "Open as preview tab (currently ignored in Obsidian)",
          } as unknown as JsonValue,
          startText: {
            type: "string",
            description: "Text snippet to locate selection start",
          } as unknown as JsonValue,
          endText: {
            type: "string",
            description: "Text snippet to locate selection end",
          } as unknown as JsonValue,
          selectToEndOfLine: {
            type: "boolean",
            description: "Extend selection to end-of-line of startText match",
          } as unknown as JsonValue,
          makeFrontmost: {
            type: "boolean",
            description: "Reveal the leaf so it's visible (default true)",
          } as unknown as JsonValue,
          line: {
            type: "number",
            description:
              "0-based line number to scroll to (Obsidian extension)",
          } as unknown as JsonValue,
        },
        required: ["filePath"],
        additionalProperties: true,
      },
    },
    async (args) => {
      const filePath = String(args?.filePath ?? "");
      const file = ctx.findFile(filePath);
      if (!file) {
        return asJson({ success: false, message: `File not found: ${filePath}` });
      }

      const makeFrontmost = args?.makeFrontmost !== false;
      const leaf = ctx.app.workspace.getLeaf(false);

      // If line is given directly, use it. Otherwise try to derive from
      // startText (locate first occurrence in the file's content).
      let line: number | undefined =
        typeof args?.line === "number" ? args.line : undefined;
      let ch = 0;
      let endLine: number | undefined;
      let endCh: number | undefined;

      const startText =
        typeof args?.startText === "string" ? args.startText : undefined;
      const endText =
        typeof args?.endText === "string" ? args.endText : undefined;

      if (startText) {
        const content = await ctx.app.vault.cachedRead(file);
        const idx = content.indexOf(startText);
        if (idx >= 0) {
          const before = content.slice(0, idx);
          const startLine = before.split("\n").length - 1;
          const lastNewline = before.lastIndexOf("\n");
          line = startLine;
          ch = lastNewline === -1 ? idx : idx - lastNewline - 1;
          if (endText) {
            const endIdx = content.indexOf(endText, idx + startText.length);
            if (endIdx >= 0) {
              const beforeEnd = content.slice(0, endIdx + endText.length);
              endLine = beforeEnd.split("\n").length - 1;
              const lastNl = beforeEnd.lastIndexOf("\n");
              endCh =
                lastNl === -1
                  ? endIdx + endText.length
                  : endIdx + endText.length - lastNl - 1;
            }
          } else if (args?.selectToEndOfLine === true) {
            const lineEnd = content.indexOf("\n", idx);
            const absEnd = lineEnd === -1 ? content.length : lineEnd;
            endLine = startLine;
            endCh = absEnd - (lastNewline + 1);
          }
        }
      }

      const eState: Record<string, unknown> = {};
      if (line !== undefined) {
        eState.line = line;
        eState.ch = ch;
        eState.scroll = line;
      }
      await leaf.openFile(file, {
        active: makeFrontmost,
        eState,
      });

      // Apply selection range if we have one (post-openFile so editor exists).
      if (line !== undefined && endLine !== undefined && endCh !== undefined) {
        const view = leaf.view as { editor?: import("obsidian").Editor } | null;
        if (view?.editor) {
          view.editor.setSelection(
            { line, ch },
            { line: endLine, ch: endCh },
          );
        }
      }

      if (makeFrontmost) ctx.app.workspace.revealLeaf(leaf);

      return asJson({
        success: true,
        filePath: file.path,
        line: line ?? null,
      });
    },
  );
}
