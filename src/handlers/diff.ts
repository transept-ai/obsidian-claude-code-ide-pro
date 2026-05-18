import * as path from "node:path";

import type { ToolRegistry } from "../tools-registry";
import { ObsidianContext, asJson } from "../obsidian-context";
import type { JsonValue } from "../rpc-router";
import { DIFF_VIEW_TYPE, DiffView, DiffResolution } from "../views/diff-view";

// openDiff is a *blocking* RPC — the handler holds its Promise open until
// the user clicks Accept or Reject. On Accept, we persist the (possibly
// further-edited) buffer-B contents to disk. On Reject, we leave the file
// untouched.
//
// Response strings ("FILE_SAVED" / "DIFF_REJECTED") match the convention
// Claude Code's diff orchestration expects — they're what tells the CLI
// whether to continue with subsequent edits or back off.
export function registerDiffTools(
  tools: ToolRegistry,
  ctx: ObsidianContext,
): void {
  tools.register(
    {
      name: "openDiff",
      description:
        "Open a side-by-side diff for a proposed file edit. Blocks until the user accepts or rejects.",
      inputSchema: {
        type: "object",
        properties: {
          old_file_path: {
            type: "string",
            description: "Path of the file being edited (vault-relative or absolute).",
          } as unknown as JsonValue,
          new_file_path: {
            type: "string",
            description: "Destination path (usually same as old_file_path).",
          } as unknown as JsonValue,
          new_file_contents: {
            type: "string",
            description: "Proposed new file contents.",
          } as unknown as JsonValue,
          tab_name: {
            type: "string",
            description: "Optional display label for the diff tab.",
          } as unknown as JsonValue,
        },
        required: ["new_file_contents"],
        additionalProperties: true,
      },
    },
    async (args) => {
      // Accept both snake_case (per VS Code convention) and camelCase
      // (some clients normalize). Be defensive.
      const oldPath = String(
        args?.old_file_path ?? args?.oldFilePath ?? args?.new_file_path ?? args?.newFilePath ?? "",
      );
      const newPath = String(
        args?.new_file_path ?? args?.newFilePath ?? oldPath,
      );
      const newContents = String(
        args?.new_file_contents ?? args?.newFileContents ?? "",
      );
      const tabName = String(
        args?.tab_name ??
          args?.tabName ??
          `Claude: ${path.basename(newPath || oldPath || "diff")}`,
      );

      const existing = oldPath ? ctx.findFile(oldPath) : null;
      const oldContents = existing
        ? await ctx.app.vault.cachedRead(existing)
        : "";

      // Open a fresh tab for the diff. Using 'tab' rather than getLeaf(true)
      // because the boolean form is deprecated and behaves inconsistently
      // across recent Obsidian versions (sometimes a horizontal split,
      // sometimes a placeholder leaf whose `view` doesn't match the
      // expected type).
      const leaf = ctx.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: DIFF_VIEW_TYPE, active: true });

      if (!(leaf.view instanceof DiffView)) {
        // Edge case: setViewState resolved but the view isn't ours. Fail
        // loudly rather than hanging. Use the same DIFF_REJECTED shape so
        // the CLI gracefully cancels rather than hanging on us.
        leaf.detach();
        return asJson({
          content: [
            { type: "text", text: "DIFF_REJECTED" },
            { type: "text", text: tabName },
          ],
        });
      }
      const view = leaf.view;

      let finalAcceptedText = newContents;
      const result = await new Promise<DiffResolution>((resolve) => {
        let settled = false;
        view.setPayload({
          oldFilePath: oldPath,
          newFilePath: newPath,
          oldContents,
          newContents,
          tabName,
          onResolve: async (resolution, finalText) => {
            if (settled) return;
            settled = true;
            if (resolution === "accept") {
              finalAcceptedText = finalText;
              // NOTE: do NOT write to disk here. Claude Code's CLI uses
              // content[1].text from our response as the authoritative new
              // file content and writes it itself. If we also write, our
              // write races the CLI's post-edit stale-read check and
              // surfaces a misleading "file content has changed" error
              // back to the LLM — even though the resulting bytes on disk
              // are identical. Trust the CLI to be the writer.
            }
            resolve(resolution);
          },
        });
        ctx.app.workspace.revealLeaf(leaf);
      });

      // Return the two-element content envelope Claude Code's CLI expects.
      // - On Accept: content[0]="FILE_SAVED" tells the CLI "the IDE handled
      //   the approval"; content[1] is the authoritative final file text
      //   the CLI uses to update its own state (and would write to disk if
      //   we hadn't already). Without content[1] the CLI falls back to its
      //   own Edit flow and prompts the user a second time in the terminal.
      // - On Reject: content[0]="DIFF_REJECTED" cancels; content[1] echoes
      //   the tab_name so the CLI can match it to the pending request.
      if (result === "accept") {
        return asJson({
          content: [
            { type: "text", text: "FILE_SAVED" },
            { type: "text", text: finalAcceptedText },
          ],
        });
      }
      return asJson({
        content: [
          { type: "text", text: "DIFF_REJECTED" },
          { type: "text", text: tabName },
        ],
      });
    },
  );

  tools.register(
    {
      name: "closeAllDiffTabs",
      description: "Close any Claude-created diff tabs.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: true,
      },
    },
    async () => {
      // Collect first, then act — detaching while iterating skews counts.
      const targets: DiffView[] = [];
      const leavesToDetach: import("obsidian").WorkspaceLeaf[] = [];
      ctx.app.workspace.iterateAllLeaves((leaf) => {
        if (leaf.view instanceof DiffView) {
          targets.push(leaf.view);
          leavesToDetach.push(leaf);
        }
      });
      // Fire reject explicitly before detaching, because Obsidian's
      // view-lifecycle hooks (onClose / onunload) don't reliably run for
      // programmatic detach in all versions.
      for (const v of targets) await v.forceReject();
      for (const leaf of leavesToDetach) leaf.detach();
      return asJson({ closed: leavesToDetach.length });
    },
  );
}

// (No persistAcceptedEdit helper any more — the CLI writes content[1].text
// itself, per the openDiff response contract. See onResolve callback above.)
