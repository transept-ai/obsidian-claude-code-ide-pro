#!/usr/bin/env node
// Smoke-tests the Obsidian-native MCP tools (Day 4).
// Read-only: never writes to the vault.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const IDE_DIR = path.join(os.homedir(), ".claude", "ide");
const AUTH_HEADER = "x-claude-code-ide-authorization";

const lock = fs
  .readdirSync(IDE_DIR)
  .filter((f) => f.endsWith(".lock"))
  .map((f) => ({
    full: path.join(IDE_DIR, f),
    data: JSON.parse(fs.readFileSync(path.join(IDE_DIR, f), "utf8")),
  }))
  .find((e) => e.data.ideName === "Obsidian");
if (!lock) {
  console.error("No Obsidian lockfile.");
  process.exit(1);
}
const port = Number(path.basename(lock.full, ".lock"));

const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
  headers: { [AUTH_HEADER]: lock.data.authToken },
});
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

function unwrap(r) {
  const text = r?.content?.[0]?.text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function callTool(name, args) {
  const result = await send("tools/call", { name, arguments: args ?? {} });
  return unwrap(result);
}

let ok = 0;
let fail = 0;
const check = (cond, label, extra = "") => {
  if (cond) {
    console.log(`  ✓ ${label}${extra ? "  " + extra : ""}`);
    ok++;
  } else {
    console.error(`  ✗ ${label}${extra ? "  " + extra : ""}`);
    fail++;
  }
};

await new Promise((r, e) => {
  ws.once("open", r);
  ws.once("error", e);
});
await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke-obsidian-tools", version: "0.0.1" },
});
ws.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));

const listResult = await send("tools/list");
const toolNames = new Set(listResult.tools.map((t) => t.name));
console.log(`Plugin exposes ${listResult.tools.length} tools total.\n`);
for (const t of [
  "getActiveNoteContent",
  "getBacklinks",
  "getOutgoingLinks",
  "resolveWikilink",
  "getFrontmatter",
  "searchVault",
  "getDailyNote",
  "listFilesInFolder",
]) {
  check(toolNames.has(t), `tool registered: ${t}`);
}

console.log("\n── getActiveNoteContent ────");
{
  const r = await callTool("getActiveNoteContent");
  if (r.error) {
    console.log("  (no active note — skipping content check)");
  } else {
    check(typeof r.text === "string", "text is string");
    check(typeof r.totalChars === "number", "totalChars is number");
    check(typeof r.truncated === "boolean", "truncated flag present");
    console.log(`  ${r.filePath} (${r.returnedChars}/${r.totalChars} chars${r.truncated ? ", truncated" : ""})`);
  }
}

console.log("\n── listFilesInFolder (Wiki/Characters) ────");
{
  const r = await callTool("listFilesInFolder", { folder: "Wiki/Characters", recursive: true });
  check(typeof r.count === "number" && r.count > 0, "found at least 1 file", `(${r.count} files)`);
  check(Array.isArray(r.files), "files is array");
  if (r.files.length) console.log(`  first: ${r.files[0]}`);
}

console.log("\n── searchVault (filename) ────");
{
  const r = await callTool("searchVault", { query: "Anna", scope: "filename" });
  check(r.total > 0, "found at least one Anna-named file", `(${r.total} hits)`);
  if (r.results.length) console.log(`  top: ${r.results[0].path}`);
}

console.log("\n── searchVault (content) ────");
{
  const r = await callTool("searchVault", { query: "Krasovitnik", scope: "content", maxResults: 5 });
  check(r.total > 0, "found content hits for 'Krasovitnik'", `(${r.total} hits)`);
  if (r.results.length) console.log(`  top: ${r.results[0].path}\n    "${r.results[0].excerpt?.slice(0, 100)}…"`);
}

console.log("\n── resolveWikilink ────");
{
  // Use canonical basename form — per CLAUDE.md, wikilinks must match the
  // basename exactly unless an alias is set in frontmatter.
  const r = await callTool("resolveWikilink", {
    wikilink: "Анна Поликариот (Anna Polikariot)",
  });
  check(r.resolved !== null && r.resolved !== undefined, "resolved canonical basename", r.resolved ? `→ ${r.resolved}` : "");

  // Unresolved case — verify graceful null return.
  const miss = await callTool("resolveWikilink", { wikilink: "ThisDoesNotExistXYZ" });
  check(miss.resolved === null, "unknown link returns resolved:null");
}

console.log("\n── getFrontmatter (a wiki article) ────");
{
  // Pick the first markdown file in Wiki/Characters
  const list = await callTool("listFilesInFolder", { folder: "Wiki/Characters", recursive: false });
  if (list.files?.length) {
    const r = await callTool("getFrontmatter", { filePath: list.files[0] });
    check(r.filePath === list.files[0], "got frontmatter for requested file");
    check(Array.isArray(r.tags), "tags is array");
    check(Array.isArray(r.headings), "headings is array");
    console.log(`  ${list.files[0]}: ${r.headings.length} headings, ${r.tags.length} tags`);
    if (r.frontmatter) {
      const keys = Object.keys(r.frontmatter);
      console.log(`  frontmatter keys: ${keys.slice(0, 6).join(", ")}${keys.length > 6 ? "…" : ""}`);
    }
  } else {
    console.log("  (no files in Wiki/Characters to test)");
  }
}

console.log("\n── getBacklinks (active file) ────");
{
  const r = await callTool("getBacklinks");
  if (r.error) console.log(`  ${r.error}`);
  else {
    check(typeof r.total === "number", "total is number");
    check(Array.isArray(r.sources), "sources is array");
    console.log(`  ${r.target}: ${r.total} backlink source(s)`);
    if (r.sources.length) {
      console.log(`  top: ${r.sources[0].path} (${r.sources[0].count} link${r.sources[0].count > 1 ? "s" : ""})`);
    }
  }
}

console.log("\n── getOutgoingLinks (active file) ────");
{
  const r = await callTool("getOutgoingLinks");
  if (r.error) console.log(`  ${r.error}`);
  else {
    check(typeof r.total === "number", "total is number");
    check(Array.isArray(r.links), "links is array");
    const resolved = r.links.filter((l) => l.resolved).length;
    console.log(`  ${r.source}: ${r.total} outgoing links (${resolved} resolved)`);
  }
}

console.log("\n── getDailyNote (today) ────");
{
  const r = await callTool("getDailyNote");
  check(typeof r.date === "string", "date present");
  console.log(`  date=${r.date} path=${r.path} exists=${r.exists}`);
}

ws.close();
console.log(`\n${ok} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
