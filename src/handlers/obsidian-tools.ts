import { TFile, TFolder, getAllTags } from "obsidian";
import * as path from "node:path";

import type { ToolRegistry } from "../tools-registry";
import { ObsidianContext, asJson } from "../obsidian-context";
import type { JsonValue } from "../rpc-router";
import type { ClaudeCodeIdeSettings } from "../settings";

// Obsidian-native MCP tools that go beyond the standard IDE protocol.
// These are what make Claude actually "Obsidian-shaped" rather than just
// file-aware: backlinks, wikilink resolution, frontmatter, vault search.
//
// Naming: tools/list exposes these alongside the standard 12. Claude Code
// surfaces unknown-name tools to the LLM (it has special-cased internal
// handling only for the standard names), so Claude can call these directly
// during a conversation.
export function registerObsidianTools(
  tools: ToolRegistry,
  ctx: ObsidianContext,
  getSettings: () => ClaudeCodeIdeSettings,
): void {
  tools.register(
    {
      name: "getActiveNoteContent",
      description:
        "Read the full text of the active markdown note. Long notes are truncated; check `truncated` and `totalChars` in the response.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Optional — defaults to the active note.",
          } as unknown as JsonValue,
        },
        additionalProperties: false,
      },
    },
    async (args) => {
      const file = await resolveFile(ctx, args?.filePath);
      if (!file) return asJson({ error: "No active or specified note." });
      const text = await ctx.app.vault.cachedRead(file);
      const cap = getSettings().contentCharCap;
      const truncated = text.length > cap;
      return asJson({
        filePath: file.path,
        text: truncated ? text.slice(0, cap) : text,
        truncated,
        totalChars: text.length,
        returnedChars: truncated ? cap : text.length,
      });
    },
  );

  tools.register(
    {
      name: "getBacklinks",
      description:
        "List every file that links to the given note. Uses Obsidian's metadata cache, so aliases and unresolved-link rewrites are respected.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Path of the target file. Defaults to the active note.",
          } as unknown as JsonValue,
        },
        additionalProperties: false,
      },
    },
    async (args) => {
      const file = await resolveFile(ctx, args?.filePath);
      if (!file) return asJson({ error: "No active or specified note." });
      const sources: { path: string; count: number }[] = [];
      const resolved = ctx.app.metadataCache.resolvedLinks as Record<
        string,
        Record<string, number>
      >;
      for (const [src, targets] of Object.entries(resolved)) {
        const count = targets[file.path];
        if (count) sources.push({ path: src, count });
      }
      sources.sort((a, b) => b.count - a.count);
      return asJson({ target: file.path, total: sources.length, sources });
    },
  );

  tools.register(
    {
      name: "getOutgoingLinks",
      description:
        "List every wikilink and markdown link in the given note, with each resolved target (or null if unresolved).",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Path of the source file. Defaults to the active note.",
          } as unknown as JsonValue,
        },
        additionalProperties: false,
      },
    },
    async (args) => {
      const file = await resolveFile(ctx, args?.filePath);
      if (!file) return asJson({ error: "No active or specified note." });
      const cache = ctx.app.metadataCache.getFileCache(file);
      const out: Array<{
        link: string;
        resolved: string | null;
        displayText: string | null;
        line: number;
      }> = [];
      for (const l of cache?.links ?? []) {
        const dest = ctx.app.metadataCache.getFirstLinkpathDest(
          l.link,
          file.path,
        );
        out.push({
          link: l.link,
          resolved: dest?.path ?? null,
          displayText: l.displayText ?? null,
          line: l.position?.start.line ?? 0,
        });
      }
      // Embeds (![[...]]) too — they're a different array.
      for (const e of cache?.embeds ?? []) {
        const dest = ctx.app.metadataCache.getFirstLinkpathDest(
          e.link,
          file.path,
        );
        out.push({
          link: e.link,
          resolved: dest?.path ?? null,
          displayText: e.displayText ?? null,
          line: e.position?.start.line ?? 0,
        });
      }
      return asJson({ source: file.path, total: out.length, links: out });
    },
  );

  tools.register(
    {
      name: "resolveWikilink",
      description:
        "Resolve a wikilink target (like 'Anna' or 'Anna|Display Text') to its canonical vault file path. Respects aliases.",
      inputSchema: {
        type: "object",
        properties: {
          wikilink: {
            type: "string",
            description: "The link text inside [[ ]] — e.g. 'Anna' or 'Wiki/Characters/Anna'.",
          } as unknown as JsonValue,
          sourcePath: {
            type: "string",
            description: "Source file path for relative resolution. Defaults to the active note.",
          } as unknown as JsonValue,
        },
        required: ["wikilink"],
        additionalProperties: false,
      },
    },
    async (args) => {
      const wikilink = String(args?.wikilink ?? "").split("|")[0].trim();
      if (!wikilink) return asJson({ error: "Empty wikilink." });
      let sourcePath = String(args?.sourcePath ?? "");
      if (!sourcePath) {
        const active = ctx.app.workspace.getActiveFile();
        sourcePath = active?.path ?? "";
      }
      const dest = ctx.app.metadataCache.getFirstLinkpathDest(
        wikilink,
        sourcePath,
      );
      if (!dest) {
        return asJson({ wikilink, resolved: null, aliases: [] });
      }
      const cache = ctx.app.metadataCache.getFileCache(dest);
      const aliasesRaw = cache?.frontmatter?.aliases;
      const aliases = Array.isArray(aliasesRaw)
        ? aliasesRaw.map(String)
        : aliasesRaw
          ? [String(aliasesRaw)]
          : [];
      return asJson({
        wikilink,
        resolved: dest.path,
        basename: dest.basename,
        aliases,
      });
    },
  );

  tools.register(
    {
      name: "getFrontmatter",
      description:
        "Return the YAML frontmatter, tags, and heading outline of the given note.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Defaults to the active note.",
          } as unknown as JsonValue,
        },
        additionalProperties: false,
      },
    },
    async (args) => {
      const file = await resolveFile(ctx, args?.filePath);
      if (!file) return asJson({ error: "No active or specified note." });
      const cache = ctx.app.metadataCache.getFileCache(file);
      const fm = (cache?.frontmatter ?? null) as JsonValue | null;
      const tags = cache ? getAllTags(cache) ?? [] : [];
      const headings = (cache?.headings ?? []).map((h) => ({
        level: h.level,
        text: h.heading,
        line: h.position?.start.line ?? 0,
      }));
      return asJson({
        filePath: file.path,
        frontmatter: fm,
        tags,
        headings,
      });
    },
  );

  tools.register(
    {
      name: "searchVault",
      description:
        "Search the vault by filename and/or content. Returns ranked hits with excerpts. For 'filename' scope, matches the basename; for 'content', greps cached file text.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query (case-insensitive substring or basename match).",
          } as unknown as JsonValue,
          scope: {
            type: "string",
            description: "'filename' | 'content' | 'both' (default both)",
          } as unknown as JsonValue,
          folder: {
            type: "string",
            description: "Restrict to a folder prefix (vault-relative).",
          } as unknown as JsonValue,
          maxResults: {
            type: "number",
            description: "Override the default cap from settings.",
          } as unknown as JsonValue,
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    async (args) => {
      const settings = getSettings();
      const query = String(args?.query ?? "").trim();
      if (!query) return asJson({ query, total: 0, results: [] });
      const scope = String(args?.scope ?? "both") as "filename" | "content" | "both";
      const folder = String(args?.folder ?? "");
      const maxResults =
        typeof args?.maxResults === "number"
          ? args.maxResults
          : settings.searchMaxResults;

      const needle = query.toLowerCase();
      const files = ctx.app.vault.getMarkdownFiles().filter((f) => {
        if (folder && !f.path.startsWith(folder)) return false;
        if (
          !settings.includeHiddenFolders &&
          f.path.split("/").some((p) => p.startsWith("."))
        )
          return false;
        return true;
      });

      type Hit = {
        path: string;
        score: number;
        kind: "filename" | "content";
        excerpt?: string;
      };
      const hits: Hit[] = [];

      if (scope === "filename" || scope === "both") {
        for (const f of files) {
          const base = f.basename.toLowerCase();
          const idx = base.indexOf(needle);
          if (idx >= 0) {
            // Score: earlier match + shorter basename = higher.
            const score = 1000 - idx - base.length * 0.1;
            hits.push({ path: f.path, score, kind: "filename" });
          }
        }
      }

      if (scope === "content" || scope === "both") {
        // Skip filename matches we already counted to avoid double-listing
        // the same file as both kinds in 'both' scope.
        const filenameMatched = new Set(
          hits.filter((h) => h.kind === "filename").map((h) => h.path),
        );
        const excerptHalf = Math.max(20, Math.floor(settings.searchExcerptChars / 2));
        for (const f of files) {
          if (filenameMatched.has(f.path)) continue;
          const text = await ctx.app.vault.cachedRead(f);
          const idx = text.toLowerCase().indexOf(needle);
          if (idx < 0) continue;
          const from = Math.max(0, idx - excerptHalf);
          const to = Math.min(text.length, idx + needle.length + excerptHalf);
          const excerpt =
            (from > 0 ? "…" : "") +
            text.slice(from, to).replace(/\s+/g, " ") +
            (to < text.length ? "…" : "");
          hits.push({ path: f.path, score: 500 - idx * 0.001, kind: "content", excerpt });
          if (hits.length >= maxResults * 2) break; // soft cap before sort
        }
      }

      hits.sort((a, b) => b.score - a.score);
      return asJson({
        query,
        scope,
        total: hits.length,
        results: hits.slice(0, maxResults),
      });
    },
  );

  tools.register(
    {
      name: "getDailyNote",
      description:
        "Return today's daily-note path (or the date you specify). Reads the Daily Notes plugin's folder + date-format settings if installed.",
      inputSchema: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "ISO date (YYYY-MM-DD). Defaults to today.",
          } as unknown as JsonValue,
        },
        additionalProperties: false,
      },
    },
    async (args) => {
      const dateStr = String(args?.date ?? formatLocalDate(new Date()));
      const cfg = readDailyNotesConfig(ctx);
      if (!cfg) {
        return asJson({
          date: dateStr,
          path: null,
          exists: false,
          reason: "Daily Notes plugin not configured.",
        });
      }
      const filename = formatDateWithMoment(dateStr, cfg.format);
      const rel = cfg.folder
        ? path.posix.join(cfg.folder, `${filename}.md`)
        : `${filename}.md`;
      const f = ctx.app.vault.getAbstractFileByPath(rel);
      return asJson({
        date: dateStr,
        path: rel,
        exists: f instanceof TFile,
      });
    },
  );

  tools.register(
    {
      name: "listFilesInFolder",
      description:
        "List markdown files under a vault folder (recursive by default).",
      inputSchema: {
        type: "object",
        properties: {
          folder: {
            type: "string",
            description: "Vault-relative folder path (use '' for vault root).",
          } as unknown as JsonValue,
          recursive: {
            type: "boolean",
            description: "Recurse into subfolders (default true).",
          } as unknown as JsonValue,
        },
        required: ["folder"],
        additionalProperties: false,
      },
    },
    (args) => {
      const settings = getSettings();
      const folder = String(args?.folder ?? "");
      const recursive = args?.recursive !== false;
      const files = ctx.app.vault
        .getMarkdownFiles()
        .filter((f) => {
          if (folder === "") {
            if (recursive) return true;
            return !f.path.includes("/");
          }
          const prefix = folder.endsWith("/") ? folder : folder + "/";
          if (!f.path.startsWith(prefix)) return false;
          if (!recursive) {
            return !f.path.slice(prefix.length).includes("/");
          }
          if (
            !settings.includeHiddenFolders &&
            f.path.split("/").some((p) => p.startsWith("."))
          )
            return false;
          return true;
        })
        .map((f) => f.path);
      return asJson({ folder, recursive, count: files.length, files });
    },
  );
}

async function resolveFile(
  ctx: ObsidianContext,
  pathArg: JsonValue | undefined,
): Promise<TFile | null> {
  const p = typeof pathArg === "string" ? pathArg.trim() : "";
  if (p) return ctx.findFile(p);
  return ctx.app.workspace.getActiveFile();
}

function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Read the Daily Notes plugin's folder/format from disk if it's installed.
function readDailyNotesConfig(
  ctx: ObsidianContext,
): { folder: string; format: string } | null {
  // Obsidian stores core-plugin configs under .obsidian/daily-notes.json.
  // The community plugin variant lives at .obsidian/plugins/<id>/data.json.
  const adapter = ctx.app.vault.adapter as unknown as {
    readJson?: (p: string) => Promise<unknown>;
  };
  void adapter;
  // Simple synchronous read via Node fs since we know the absolute path.
  // Avoids racy Vault adapter calls in a tool response.
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const p = `${ctx.vaultRoot}/.obsidian/daily-notes.json`;
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as {
      folder?: string;
      format?: string;
    };
    return { folder: raw.folder ?? "", format: raw.format ?? "YYYY-MM-DD" };
  } catch {
    return null;
  }
}

// Minimal moment-like formatter — supports the most common date-format tokens
// used by Daily Notes (YYYY, YY, MM, DD, MMM, MMMM, dddd, ddd).
function formatDateWithMoment(isoDate: string, format: string): string {
  const [yStr, mStr, dStr] = isoDate.split("-");
  const d = new Date(Number(yStr), Number(mStr) - 1, Number(dStr));
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const replacements: Array<[RegExp, string]> = [
    [/YYYY/g, String(d.getFullYear())],
    [/YY/g, String(d.getFullYear() % 100).padStart(2, "0")],
    [/MMMM/g, months[d.getMonth()]],
    [/MMM/g, months[d.getMonth()].slice(0, 3)],
    [/MM/g, String(d.getMonth() + 1).padStart(2, "0")],
    [/DD/g, String(d.getDate()).padStart(2, "0")],
    [/dddd/g, days[d.getDay()]],
    [/ddd/g, days[d.getDay()].slice(0, 3)],
  ];
  let out = format;
  for (const [pattern, value] of replacements) {
    out = out.replace(pattern, value);
  }
  return out;
}

// Silence unused-import warning — TFolder is imported for type narrowing
// callers may want later.
const _unused = TFolder;
void _unused;
