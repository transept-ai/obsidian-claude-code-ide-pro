import { ItemView, WorkspaceLeaf } from "obsidian";
import { MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";

export const DIFF_VIEW_TYPE = "claude-code-ide-diff";

export type DiffResolution = "accept" | "reject";

export interface DiffPayload {
  oldFilePath: string;
  newFilePath: string;
  oldContents: string;
  newContents: string;
  tabName: string;
  onResolve: (
    resolution: DiffResolution,
    finalContents: string,
  ) => void | Promise<void>;
}

// ItemView hosting a CodeMirror 6 MergeView. The Promise lifecycle is owned
// by the caller (handlers/diff.ts) — we just emit "accept" / "reject" via the
// onResolve callback and let the caller resolve its outstanding Promise.
//
// If the view is closed without explicit Accept/Reject (e.g. user hits "x"
// on the tab), we emit "reject" in onunload so Claude isn't left hanging.
export class DiffView extends ItemView {
  private payload?: DiffPayload;
  private mergeView?: MergeView;
  private resolved = false;
  private acceptBtn?: HTMLButtonElement;
  private rejectBtn?: HTMLButtonElement;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return DIFF_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.payload?.tabName ?? "Claude Diff";
  }

  getIcon(): string {
    return "git-compare";
  }

  setPayload(payload: DiffPayload): void {
    this.payload = payload;
    this.render();
  }

  async onClose(): Promise<void> {
    await this.fireRejectIfUnresolved();
    this.mergeView?.destroy();
    this.mergeView = undefined;
  }

  // Belt-and-suspenders: onClose isn't reliably called on programmatic
  // leaf.detach() in all Obsidian versions — onunload is. Override both so
  // closeAllDiffTabs definitely resolves any open Promise.
  onunload(): void {
    void this.fireRejectIfUnresolved();
    super.onunload();
  }

  // Called by closeAllDiffTabs so the reject runs *before* detach (rather
  // than depending on Obsidian's view lifecycle to fire it after detach).
  async forceReject(): Promise<void> {
    await this.fireRejectIfUnresolved();
  }

  private async fireRejectIfUnresolved(): Promise<void> {
    if (!this.payload || this.resolved) return;
    this.resolved = true;
    await this.payload.onResolve("reject", this.payload.oldContents);
  }

  private render(): void {
    if (!this.payload) return;
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("claude-code-ide-diff-view");

    const header = container.createDiv({ cls: "ccide-diff-header" });
    header.createSpan({ cls: "ccide-diff-title", text: this.payload.tabName });

    const actions = header.createDiv({ cls: "ccide-diff-actions" });
    this.rejectBtn = actions.createEl("button", {
      text: "Reject",
      cls: "mod-warning",
    });
    this.acceptBtn = actions.createEl("button", {
      text: "Accept",
      cls: "mod-cta",
    });

    this.rejectBtn.addEventListener("click", () => this.finish("reject"));
    this.acceptBtn.addEventListener("click", () => this.finish("accept"));

    const host = container.createDiv({ cls: "ccide-merge-host" });

    const editorExt = [
      lineNumbers(),
      EditorView.lineWrapping,
      EditorView.theme({
        "&": { fontSize: "var(--editor-font-size, 14px)" },
      }),
    ];

    this.mergeView = new MergeView({
      a: {
        doc: this.payload.oldContents,
        extensions: [
          ...editorExt,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
        ],
      },
      b: {
        doc: this.payload.newContents,
        extensions: [...editorExt],
      },
      parent: host,
      revertControls: "a-to-b",
      collapseUnchanged: { margin: 3, minSize: 4 },
    });
  }

  private async finish(resolution: DiffResolution): Promise<void> {
    if (this.resolved || !this.payload) return;
    this.resolved = true;
    if (this.acceptBtn) this.acceptBtn.disabled = true;
    if (this.rejectBtn) this.rejectBtn.disabled = true;
    const finalText =
      this.mergeView?.b.state.doc.toString() ?? this.payload.newContents;
    await this.payload.onResolve(resolution, finalText);
    this.leaf.detach();
  }
}
