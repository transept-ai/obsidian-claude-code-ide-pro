#!/usr/bin/env node
// Exercises every IDE tool against the running Obsidian plugin.
// Validates response shapes match what Claude Code expects.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const IDE_DIR = path.join(os.homedir(), ".claude", "ide");
const AUTH_HEADER = "x-claude-code-ide-authorization";

function findObsidianLock() {
  const entries = fs
    .readdirSync(IDE_DIR)
    .filter((f) => f.endsWith(".lock"))
    .map((f) => {
      try {
        return {
          full: path.join(IDE_DIR, f),
          data: JSON.parse(fs.readFileSync(path.join(IDE_DIR, f), "utf8")),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const obs = entries.find((e) => e.data.ideName === "Obsidian");
  if (!obs) {
    console.error("No Obsidian lockfile found.");
    process.exit(1);
  }
  return obs;
}

function connect({ port, authToken }) {
  return new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { [AUTH_HEADER]: authToken },
  });
}

function call(ws, method, params) {
  const id = Math.floor(Math.random() * 1e9);
  const payload = { jsonrpc: "2.0", id, method };
  if (params !== undefined) payload.params = params;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 5000);
    const onMessage = (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify(payload));
  });
}

// tools/call wraps results in {content: [{type, text}]}. Unwrap to the inner
// JSON the tool actually returned.
function unwrap(toolCallResult) {
  const text = toolCallResult?.content?.[0]?.text;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function assert(cond, label) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  }
}

async function callTool(ws, name, args) {
  const r = await call(ws, "tools/call", { name, arguments: args ?? {} });
  return { raw: r, result: unwrap(r), isError: !!r?.isError };
}

async function main() {
  const lock = findObsidianLock();
  const port = Number(path.basename(lock.full, ".lock"));
  console.log(`→ Connecting :${port} (${lock.data.workspaceFolders[0]})`);

  const ws = connect({ port, authToken: lock.data.authToken });
  await new Promise((r, e) => {
    ws.once("open", r);
    ws.once("error", e);
  });
  await call(ws, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-tools", version: "0.0.1" },
  });
  ws.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));

  console.log("\n── getWorkspaceFolders ──────");
  {
    const { result } = await callTool(ws, "getWorkspaceFolders");
    console.log(`  folders: ${result.folders.map((f) => f.path).join(", ")}`);
    assert(result.folders.length === 1, "exactly one folder");
    assert(result.folders[0].path === lock.data.workspaceFolders[0], "matches lockfile workspace");
    assert(result.folders[0].uri.startsWith("file://"), "uri is file://");
  }

  console.log("\n── getOpenEditors ───────────");
  let firstOpenFile = null;
  {
    const { result } = await callTool(ws, "getOpenEditors");
    console.log(`  ${result.tabs.length} tab(s)`);
    for (const t of result.tabs) {
      const flags = [t.isActive && "active", t.isDirty && "dirty"].filter(Boolean);
      console.log(`    - ${t.label}${flags.length ? ` (${flags.join(",")})` : ""}`);
    }
    assert(Array.isArray(result.tabs), "tabs is array");
    if (result.tabs.length > 0) {
      const t = result.tabs[0];
      firstOpenFile = decodeURIComponent(t.uri.replace(/^file:\/\//, ""));
      assert(t.uri && t.label && t.languageId, "tab has uri/label/languageId");
    }
  }

  console.log("\n── getCurrentSelection ──────");
  {
    const { result } = await callTool(ws, "getCurrentSelection");
    const len = result.text?.length ?? 0;
    console.log(
      `  file: ${result.filePath || "(none)"}\n  ` +
        `selection: lines ${result.selection.start.line}:${result.selection.start.character} → ${result.selection.end.line}:${result.selection.end.character}, isEmpty=${result.selection.isEmpty}, ${len} chars`,
    );
    assert(typeof result.text === "string", "text field is string");
    assert(typeof result.selection.isEmpty === "boolean", "isEmpty boolean");
  }

  console.log("\n── getLatestSelection ───────");
  {
    const { result } = await callTool(ws, "getLatestSelection");
    if (!result) console.log("  (no cached selection yet)");
    else console.log(`  file: ${result.filePath}, ${result.text?.length ?? 0} chars`);
    assert(true, "responded without error");
  }

  if (firstOpenFile) {
    console.log("\n── checkDocumentDirty ───────");
    const { result } = await callTool(ws, "checkDocumentDirty", { filePath: firstOpenFile });
    console.log(`  file: ${path.basename(firstOpenFile)} → isDirty=${result.isDirty}, isOpen=${result.isOpen}`);
    assert(typeof result.isDirty === "boolean", "isDirty boolean");
    assert(result.isOpen === true, "isOpen true for known open file");
  }

  console.log("\n── getDiagnostics ───────────");
  {
    const { result } = await callTool(ws, "getDiagnostics");
    assert(Array.isArray(result) && result.length === 0, "empty array");
  }

  console.log("\n── executeCode ──────────────");
  {
    const { result, isError } = await callTool(ws, "executeCode", { code: "print('hi')" });
    console.log(`  ${result.message || JSON.stringify(result)}`);
    assert(result.success === false, "returns success:false");
    assert(isError === false, "not an isError response (returns soft failure)");
  }

  // openDiff is covered by smoke-diff.mjs (it's a blocking RPC and exercising
  // it here would hang this script — that's why it lives in its own test).

  ws.close();
  console.log(
    process.exitCode === 1
      ? "\nFAILURES present above."
      : "\nAll Day-2 tools behave correctly.",
  );
}

main().catch((err) => {
  console.error("Smoke test failed:", err.message);
  process.exit(3);
});
