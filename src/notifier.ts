import { Plugin } from "obsidian";
import { EditorView } from "@codemirror/view";

import type { IdeWsServer } from "./ws-server";
import type { ObsidianContext } from "./obsidian-context";
import type { JsonValue } from "./rpc-router";

const DEBOUNCE_MS = 150;

// Subscribes to every Obsidian signal that changes the "what is the user
// looking at and what have they selected?" state, and pushes
// selection_changed notifications to all connected clients.
//
// We debounce because CodeMirror fires selectionSet on every drag pixel and
// every keystroke that moves the cursor — without debounce we'd blast 30+
// notifications/sec during a normal text selection drag.
export class SelectionNotifier {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastPayloadKey = "";

  constructor(
    private readonly plugin: Plugin,
    private readonly server: IdeWsServer,
    private readonly ctx: ObsidianContext,
  ) {}

  install(): void {
    const ws = this.plugin.app.workspace;
    this.plugin.registerEvent(
      ws.on("active-leaf-change", () => this.schedule()),
    );
    this.plugin.registerEvent(ws.on("file-open", () => this.schedule()));
    this.plugin.registerEvent(
      ws.on("editor-change", () => this.schedule()),
    );

    // CodeMirror selection events — only thing that catches mouse-drag and
    // arrow-key cursor moves.
    const ext = EditorView.updateListener.of((update) => {
      if (update.selectionSet || update.docChanged) this.schedule();
    });
    this.plugin.registerEditorExtension([ext]);
  }

  uninstall(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  // Force-flush, used when a new client connects so they receive the current
  // state without having to wait for the user to move the cursor. We clear
  // the dedup cache so the emit definitely fires.
  flushNow(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.lastPayloadKey = "";
    this.emit();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.emit();
    }, DEBOUNCE_MS);
  }

  private emit(): void {
    const view = this.ctx.findActiveMarkdownView();
    if (!view) return;
    const sel = this.ctx.buildSelectionFromView(view);
    if (!sel) return;
    this.ctx.setLatestSelection(sel);

    // Deduplicate: if nothing changed, skip the broadcast.
    const key = JSON.stringify(sel);
    if (key === this.lastPayloadKey) return;
    this.lastPayloadKey = key;

    this.server.broadcast("selection_changed", sel as unknown as JsonValue);
  }
}
