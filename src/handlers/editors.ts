import { MarkdownView, WorkspaceLeaf } from "obsidian";

import type { ToolRegistry } from "../tools-registry";
import { ObsidianContext, asJson } from "../obsidian-context";
import type { JsonValue } from "../rpc-router";

// Selection / tabs / saving — everything that's about the current editor
// state without opening new files. (openFile lives in files.ts.)
export function registerEditorTools(
  tools: ToolRegistry,
  ctx: ObsidianContext,
): void {
  tools.register(
    {
      name: "getOpenEditors",
      description: "List the user's open markdown tabs in Obsidian.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    () => asJson({ tabs: ctx.describeOpenEditors() }),
  );

  tools.register(
    {
      name: "getCurrentSelection",
      description: "Get the current selection in the active markdown editor.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    () => {
      const sel = ctx.buildActiveSelection();
      if (sel) ctx.setLatestSelection(sel);
      return asJson(sel ?? {
        text: "",
        filePath: "",
        fileUrl: "",
        selection: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
          isEmpty: true,
        },
      });
    },
  );

  tools.register(
    {
      name: "getLatestSelection",
      description:
        "Get the most recent non-empty selection observed across editors.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    () => {
      const latest = ctx.getLatestSelection();
      if (latest) return asJson(latest);
      // Fall back to current selection if nothing cached yet.
      const sel = ctx.buildActiveSelection();
      if (sel) ctx.setLatestSelection(sel);
      return asJson(sel ?? null);
    },
  );

  tools.register(
    {
      name: "getWorkspaceFolders",
      description: "Return the workspace folder(s) Obsidian has open.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    () =>
      asJson({
        folders: [
          {
            name: pathBasename(ctx.vaultRoot),
            uri: ctx.toFileUrl(ctx.vaultRoot),
            path: ctx.vaultRoot,
          },
        ],
      }),
  );

  tools.register(
    {
      name: "checkDocumentDirty",
      description: "Report whether a given file has unsaved changes.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Absolute or vault-relative path",
          } as unknown as JsonValue,
        },
        required: ["filePath"],
        additionalProperties: false,
      },
    },
    (args) => {
      const filePath = String(args?.filePath ?? "");
      const view = findMarkdownViewForPath(ctx, filePath);
      const isDirty = !!(view as unknown as { dirty?: boolean })?.dirty;
      return asJson({ isDirty, isOpen: !!view });
    },
  );

  tools.register(
    {
      name: "saveDocument",
      description: "Persist a file's unsaved changes to disk.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Absolute or vault-relative path",
          } as unknown as JsonValue,
        },
        required: ["filePath"],
        additionalProperties: false,
      },
    },
    async (args) => {
      const filePath = String(args?.filePath ?? "");
      const view = findMarkdownViewForPath(ctx, filePath);
      if (!view) {
        return asJson({ saved: false, reason: "File not open in any tab" });
      }
      await view.save();
      return asJson({ saved: true });
    },
  );

  tools.register(
    {
      name: "close_tab",
      description: "Close the tab whose label matches the given name.",
      inputSchema: {
        type: "object",
        properties: {
          tab_name: {
            type: "string",
            description: "The tab's display label (file basename or path)",
          } as unknown as JsonValue,
        },
        required: ["tab_name"],
        additionalProperties: false,
      },
    },
    (args) => {
      const name = String(args?.tab_name ?? "");
      let closed = 0;
      ctx.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
        const view = leaf.view;
        if (!(view instanceof MarkdownView)) return;
        const f = view.file;
        if (!f) return;
        const label = f.basename + "." + f.extension;
        if (label === name || f.path === name || f.basename === name) {
          leaf.detach();
          closed++;
        }
      });
      return asJson({ closed });
    },
  );
}

// Locate the MarkdownView currently displaying a given file path.
function findMarkdownViewForPath(
  ctx: ObsidianContext,
  filePath: string,
): MarkdownView | null {
  const file = ctx.findFile(filePath);
  if (!file) return null;
  let found: MarkdownView | null = null;
  ctx.app.workspace.iterateAllLeaves((leaf) => {
    if (found) return;
    const v = leaf.view;
    if (v instanceof MarkdownView && v.file?.path === file.path) found = v;
  });
  return found;
}

function pathBasename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}
