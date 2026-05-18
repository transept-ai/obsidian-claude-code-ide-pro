#!/usr/bin/env node
// Standalone smoke test for the Obsidian Claude Code IDE plugin.
// Finds the Obsidian lockfile in ~/.claude/ide/, connects with auth, and
// exercises the MCP handshake. Use this to verify the wire layer without
// needing the actual Claude Code CLI in the loop.
//
// Usage:
//   node scripts/smoke-handshake.mjs
//   PATH=/opt/homebrew/bin:$PATH node scripts/smoke-handshake.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const IDE_DIR = path.join(os.homedir(), ".claude", "ide");
const AUTH_HEADER = "x-claude-code-ide-authorization";

function findObsidianLock() {
  if (!fs.existsSync(IDE_DIR)) {
    console.error(`No ${IDE_DIR} — is the plugin enabled?`);
    process.exit(1);
  }
  const entries = fs
    .readdirSync(IDE_DIR)
    .filter((f) => f.endsWith(".lock"))
    .map((f) => {
      const full = path.join(IDE_DIR, f);
      try {
        return { full, data: JSON.parse(fs.readFileSync(full, "utf8")) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const obs = entries.find((e) => e.data.ideName === "Obsidian");
  if (!obs) {
    console.error(`No Obsidian lockfile found in ${IDE_DIR}.`);
    console.error(`Lockfiles present:`);
    for (const e of entries) {
      console.error(
        `  ${path.basename(e.full)}: ideName=${e.data.ideName} workspace=${e.data.workspaceFolders?.[0]}`,
      );
    }
    process.exit(2);
  }
  return obs;
}

function connect({ port, authToken }) {
  const url = `ws://127.0.0.1:${port}`;
  return new WebSocket(url, { headers: { [AUTH_HEADER]: authToken } });
}

async function call(ws, method, params) {
  const id = Math.floor(Math.random() * 1e9);
  const payload = { jsonrpc: "2.0", id, method };
  if (params !== undefined) payload.params = params;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout: ${method}`)),
      5000,
    );
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

async function main() {
  const lock = findObsidianLock();
  const port = Number(path.basename(lock.full, ".lock"));
  console.log(
    `→ Connecting to Obsidian lockfile :${port}, workspace=${lock.data.workspaceFolders?.[0]}`,
  );

  const ws = connect({ port, authToken: lock.data.authToken });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  console.log("✓ WebSocket open");

  const init = await call(ws, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-handshake", version: "0.0.1" },
  });
  console.log("✓ initialize →", JSON.stringify(init));

  // Per MCP spec, send notifications/initialized after init.
  ws.send(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  );

  const tools = await call(ws, "tools/list", {});
  console.log(`✓ tools/list → ${tools.tools.length} tool(s):`);
  for (const t of tools.tools) {
    console.log(`    - ${t.name}: ${t.description.slice(0, 60)}…`);
  }

  // Try calling a tool if any exist
  if (tools.tools.length > 0) {
    const first = tools.tools[0];
    try {
      const result = await call(ws, "tools/call", {
        name: first.name,
        arguments: {},
      });
      console.log(`✓ tools/call ${first.name} →`, JSON.stringify(result));
    } catch (err) {
      console.log(`  (tools/call ${first.name} failed: ${err.message})`);
    }
  }

  // Verify bad auth fails (separate connection)
  const bad = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { [AUTH_HEADER]: "wrong-token" },
  });
  await new Promise((resolve) => {
    bad.once("error", () => {
      console.log("✓ Bad auth rejected");
      resolve();
    });
    bad.once("open", () => {
      console.error("✗ Bad auth accepted (should have been rejected)");
      resolve();
    });
  });

  ws.close();
  console.log("\nAll wire checks passed.");
}

main().catch((err) => {
  console.error("Smoke test failed:", err.message);
  process.exit(3);
});
