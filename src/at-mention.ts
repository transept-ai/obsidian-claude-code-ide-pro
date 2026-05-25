import { Editor, MarkdownFileInfo, MarkdownView, Menu, Notice, Plugin } from "obsidian";
import * as path from "node:path";

import type { IdeWsServer } from "./ws-server";
import type { ObsidianContext } from "./obsidian-context";
import type { JsonValue } from "./rpc-router";

// "Send to Claude" — active push of the current selection (or the whole
// note if nothing is selected) into the connected Claude pane via the
// protocol's `at_mentioned` notification. This is the IDE→Claude channel
// VS Code uses when you @-mention a file or right-click "Add Selection
// to Chat"; without it the only way to put a passage in front of Claude
// is to copy-paste.
//
// Payload shape per claudecode.nvim PROTOCOL.md:
//   { filePath: <absolute>, lineStart: <1-based>, lineEnd: <1-based inclusive> }
export class AtMentionController {
  constructor(
    private readonly plugin: Plugin,
    private readonly server: IdeWsServer,
    private readonly ctx: ObsidianContext,
  ) {}

  install(): void {
    this.plugin.addCommand({
      id: "send-to-claude",
      name: "Send to Claude (selection or whole note)",
      icon: "send",
      checkCallback: (checking) => {
        const view = this.ctx.findActiveMarkdownView();
        if (!view?.file) return false;
        if (!checking) this.sendFromView(view, view.editor);
        return true;
      },
    });

    this.plugin.registerEvent(
      this.plugin.app.workspace.on(
        "editor-menu",
        (menu: Menu, editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
          if (editor.getSelection().length === 0) return;
          const view = info instanceof MarkdownView ? info : null;
          if (!view?.file) return;
          menu.addItem((item) =>
            item
              .setTitle("Send selection to Claude")
              .setIcon("send")
              .onClick(() => this.sendFromView(view, editor)),
          );
        },
      ),
    );
  }

  private sendFromView(view: MarkdownView, editor: Editor): void {
    const file = view.file;
    if (!file) return;

    if (this.server.clientCount() === 0) {
      new Notice(
        "Claude Code: no IDE client connected. Type /ide in the Claude pane first.",
        4000,
      );
      return;
    }

    const selText = editor.getSelection();
    const hasSelection = selText.length > 0;

    let lineStart: number;
    let lineEnd: number;
    if (hasSelection) {
      const from = editor.getCursor("from");
      const to = editor.getCursor("to");
      lineStart = from.line + 1;
      // If the cursor ends at column 0 on a new line (common when the user
      // drag-selects past a line break), that line shouldn't count.
      lineEnd = to.ch === 0 && to.line > from.line ? to.line : to.line + 1;
    } else {
      lineStart = 1;
      lineEnd = Math.max(1, editor.lineCount());
    }

    const absPath = path.join(this.ctx.vaultRoot, file.path);
    const payload = {
      filePath: absPath,
      lineStart,
      lineEnd,
    } as unknown as JsonValue;
    this.server.broadcast("at_mentioned", payload);

    const what = hasSelection
      ? `selection (lines ${lineStart}–${lineEnd})`
      : "whole note";
    new Notice(`Sent ${what} to Claude: ${file.basename}`, 2500);
  }
}
