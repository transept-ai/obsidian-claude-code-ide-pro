#!/usr/bin/env node
// Exercises openDiff and closeAllDiffTabs without touching the vault.
//
// Flow:
//   1. Send openDiff with a proposed edit to TODO.md (request stays
//      unresolved — diff view is now open in Obsidian).
//   2. After 2s, call closeAllDiffTabs to programmatically close it.
//   3. The first openDiff response should come back as DIFF_REJECTED
//      (because the leaf was detached without clicking Accept).
//
// This proves the blocking Promise, the cleanup-on-detach path, and the
// closeAllDiffTabs side door all work together. The vault is never modified.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const IDE_DIR = path.join(os.homedir(), ".claude", "ide");
const AUTH_HEADER = "x-claude-code-ide-authorization";

const entries = fs
  .readdirSync(IDE_DIR)
  .filter((f) => f.endsWith(".lock"))
  .map((f) => ({
    full: path.join(IDE_DIR, f),
    data: JSON.parse(fs.readFileSync(path.join(IDE_DIR, f), "utf8")),
  }));
const obs = entries.find((e) => e.data.ideName === "Obsidian");
if (!obs) {
  console.error("No Obsidian lockfile.");
  process.exit(1);
}
const port = Number(path.basename(obs.full, ".lock"));
const vaultRoot = obs.data.workspaceFolders[0];

const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
  headers: { [AUTH_HEADER]: obs.data.authToken },
});

// Track outstanding requests by id.
const pending = new Map();
ws.on("message", (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw.toString("utf8"));
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
});

function send(method, params) {
  const id = Math.floor(Math.random() * 1e9);
  const payload = { jsonrpc: "2.0", id, method };
  if (params !== undefined) payload.params = params;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify(payload));
  });
}

// For openDiff, Claude Code's CLI expects content[0].text to be the magic
// signal ("FILE_SAVED" / "DIFF_REJECTED") and content[1].text to be either
// the final file contents (Accept) or the tab_name (Reject). For other
// tools we still want the JSON-parsed content[0] payload.
function unwrap(r) {
  const text = r?.content?.[0]?.text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function unwrapDiff(r) {
  return {
    signal: r?.content?.[0]?.text ?? null,
    secondText: r?.content?.[1]?.text ?? null,
  };
}

await new Promise((r, e) => {
  ws.once("open", r);
  ws.once("error", e);
});
await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke-diff", version: "0.0.1" },
});
ws.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));

const targetFile = path.join(vaultRoot, "TODO.md");
const oldText = fs.readFileSync(targetFile, "utf8");
const newText =
  "# CHANGED HEADER (from smoke-diff)\n\n" + oldText.split("\n").slice(1).join("\n");

console.log(`→ Opening diff for ${path.basename(targetFile)}`);
const diffPromise = send("tools/call", {
  name: "openDiff",
  arguments: {
    old_file_path: targetFile,
    new_file_path: targetFile,
    new_file_contents: newText,
    tab_name: "smoke-diff (will be rejected)",
  },
});

// Give the diff view time to mount and wire up its onResolve callback. The
// race we're avoiding: closeAllDiffTabs detaching the leaf before
// DiffView.setPayload has been called — onClose would then no-op.
await new Promise((r) => setTimeout(r, 4000));

console.log("→ Calling closeAllDiffTabs to dismiss it");
const closeResult = await send("tools/call", {
  name: "closeAllDiffTabs",
  arguments: {},
});
console.log("  closeAllDiffTabs →", unwrap(closeResult));

// Race the diff response against a hard timeout so a regression in the
// reject path doesn't hang the test indefinitely.
const diffResult = await Promise.race([
  diffPromise.then(unwrapDiff),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error("openDiff response timeout (10s)")), 10000),
  ),
]);
console.log("→ openDiff resolved →", diffResult);

let ok = 0;
let fail = 0;
const check = (cond, label) => {
  if (cond) {
    console.log(`  ✓ ${label}`);
    ok++;
  } else {
    console.error(`  ✗ ${label}`);
    fail++;
  }
};

check(unwrap(closeResult).closed >= 1, "closeAllDiffTabs closed at least 1 leaf");
// openDiff returns a two-element content envelope: content[0]="DIFF_REJECTED"
// signals the cancel, content[1] echoes the tab_name so the CLI matches it
// to the pending request. Verify both.
check(
  diffResult.signal === "DIFF_REJECTED",
  "openDiff content[0] = DIFF_REJECTED on detach",
);
check(
  typeof diffResult.secondText === "string",
  "openDiff content[1] present (tab_name echo)",
);

// Verify the file was NOT modified.
const afterText = fs.readFileSync(targetFile, "utf8");
check(afterText === oldText, "vault file unchanged");

ws.close();
console.log(`\n${ok} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
