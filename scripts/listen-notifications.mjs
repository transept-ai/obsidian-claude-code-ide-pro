#!/usr/bin/env node
// Connects to the Obsidian IDE server and prints any JSON-RPC notifications
// (no id) it receives. Use to verify selection_changed pushes work:
//
//   node scripts/listen-notifications.mjs
//   # then in Obsidian, click around, select text, switch tabs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const IDE_DIR = path.join(os.homedir(), ".claude", "ide");
const AUTH_HEADER = "x-claude-code-ide-authorization";
const DURATION_MS = Number(process.argv[2] ?? "30") * 1000;

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

const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
  headers: { [AUTH_HEADER]: obs.data.authToken },
});

ws.on("open", () => {
  console.log(
    `Listening for notifications on :${port} for ${DURATION_MS / 1000}s. Try clicking around in Obsidian.\n`,
  );
  // Send initialize so server treats us as a real client.
  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "listen-notifications", version: "0.0.1" },
      },
    }),
  );
  setTimeout(() => {
    ws.close();
    process.exit(0);
  }, DURATION_MS);
});

ws.on("message", (raw) => {
  const text = raw.toString("utf8");
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    console.log("(non-JSON)", text);
    return;
  }
  if (msg.id !== undefined) {
    // It's a response to our initialize — ignore.
    return;
  }
  // It's a notification.
  const ts = new Date().toISOString().slice(11, 23);
  if (msg.method === "selection_changed") {
    const p = msg.params ?? {};
    const len = p.text?.length ?? 0;
    const filePath = p.filePath ? path.basename(p.filePath) : "(no file)";
    const empty = p.selection?.isEmpty;
    const range = `${p.selection?.start?.line}:${p.selection?.start?.character}→${p.selection?.end?.line}:${p.selection?.end?.character}`;
    console.log(
      `[${ts}] selection_changed  ${filePath}  ${range}  ${empty ? "(empty)" : `${len} chars`}`,
    );
  } else {
    console.log(`[${ts}] ${msg.method}`, JSON.stringify(msg.params).slice(0, 100));
  }
});

ws.on("error", (err) => {
  console.error("ws error:", err.message);
  process.exit(1);
});
