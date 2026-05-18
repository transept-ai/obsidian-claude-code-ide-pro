import { App, MarkdownView, TFile, WorkspaceLeaf } from "obsidian";
import * as path from "node:path";
import * as url from "node:url";

import type { JsonValue } from "./rpc-router";

// Selection payload shared between getCurrentSelection / getLatestSelection /
// selection_changed notifications. Mirrors the shape every Claude Code IDE
// host implementation uses (VS Code, JetBrains, claudecode.nvim).
export interface SelectionPayload {
  text: string;
  filePath: string;
  fileUrl: string;
  selection: {
    start: { line: number; character: number };
    end: { line: number; character: number };
    isEmpty: boolean;
  };
}

// Per-tab descriptor returned by getOpenEditors.
export interface TabDescriptor {
  uri: string;
  isActive: boolean;
  isDirty: boolean;
  isPinned: boolean;
  isPreview: boolean;
  label: string;
  languageId: string;
}

// Holds App + cached state. Every handler receives this.
// Cached selection is what powers getLatestSelection — if the user no longer
// has anything selected, Claude can still ask "what was your last selection?".
export class ObsidianContext {
  private latestSelection?: SelectionPayload;

  constructor(
    public readonly app: App,
    public readonly vaultRoot: string,
  ) {}

  setLatestSelection(sel: SelectionPayload | undefined): void {
    if (sel) this.latestSelection = sel;
  }

  getLatestSelection(): SelectionPayload | undefined {
    return this.latestSelection;
  }

  // Resolve a vault-relative or absolute path to an absolute path.
  // Claude Code may send either form depending on what tool produced it.
  resolveAbsolute(p: string): string {
    if (path.isAbsolute(p)) return p;
    return path.join(this.vaultRoot, p);
  }

  // Convert absolute path to vault-relative path (or return absolute if
  // outside the vault).
  toVaultRelative(absPath: string): string {
    const rel = path.relative(this.vaultRoot, absPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return absPath;
    return rel;
  }

  // file:// URL for a given absolute path. Required by getCurrentSelection
  // response shape — Claude Code re-resolves files via these in some paths.
  toFileUrl(absPath: string): string {
    return url.pathToFileURL(absPath).href;
  }

  // Find the TFile for a given path. Accepts absolute or vault-relative.
  findFile(p: string): TFile | null {
    const rel = this.toVaultRelative(this.resolveAbsolute(p));
    const f = this.app.vault.getAbstractFileByPath(rel);
    return f instanceof TFile ? f : null;
  }

  // Build a SelectionPayload from a MarkdownView's current editor state.
  buildSelectionFromView(view: MarkdownView): SelectionPayload | undefined {
    const file = view.file;
    if (!file) return undefined;
    const ed = view.editor;
    const from = ed.getCursor("from");
    const to = ed.getCursor("to");
    const text = ed.getSelection();
    const isEmpty = from.line === to.line && from.ch === to.ch;
    const absPath = path.join(this.vaultRoot, file.path);
    return {
      text,
      filePath: absPath,
      fileUrl: this.toFileUrl(absPath),
      selection: {
        start: { line: from.line, character: from.ch },
        end: { line: to.line, character: to.ch },
        isEmpty,
      },
    };
  }

  buildActiveSelection(): SelectionPayload | undefined {
    const view = this.findActiveMarkdownView();
    if (!view) return undefined;
    return this.buildSelectionFromView(view);
  }

  // Returns the focused markdown view if there is one, otherwise the most
  // recently-active markdown leaf. Mirrors how VS Code's getCurrentSelection
  // behaves — it doesn't care if focus is on the terminal pane.
  findActiveMarkdownView(): MarkdownView | null {
    const focused = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (focused) return focused;
    const recent = this.app.workspace.getMostRecentLeaf();
    if (recent && recent.view instanceof MarkdownView) return recent.view;
    // Last resort: any markdown leaf.
    let any: MarkdownView | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (any) return;
      if (leaf.view instanceof MarkdownView) any = leaf.view;
    });
    return any;
  }

  // Iterate every markdown leaf as a TabDescriptor.
  describeOpenEditors(): TabDescriptor[] {
    const tabs: TabDescriptor[] = [];
    const activeLeaf = this.app.workspace.getMostRecentLeaf();
    this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) return;
      const f = view.file;
      if (!f) return;
      const absPath = path.join(this.vaultRoot, f.path);
      const isActive = leaf === activeLeaf;
      const isDirty = !!(view as unknown as { dirty?: boolean }).dirty;
      const label = f.basename + (f.extension ? `.${f.extension}` : "");
      const state = leaf.getViewState();
      const isPinned = !!leaf.getViewState().pinned;
      const isPreview = !!(state?.state?.mode === "preview");
      tabs.push({
        uri: this.toFileUrl(absPath),
        isActive,
        isDirty,
        isPinned,
        isPreview,
        label,
        languageId: "markdown",
      });
    });
    return tabs;
  }
}

// Convenience cast for JSON serialization without `as JsonValue` clutter.
export function asJson<T>(v: T): JsonValue {
  return v as unknown as JsonValue;
}
