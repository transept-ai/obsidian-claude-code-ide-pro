import { App, PluginSettingTab, Setting } from "obsidian";

import type ClaudeCodeIdePlugin from "./main";

export interface ClaudeCodeIdeSettings {
  // Maximum characters returned by getActiveNoteContent. Long notes are
  // truncated and flagged. Default sized to fit a generous chunk of context
  // without blowing through Claude's tool-result budget.
  contentCharCap: number;
  // Maximum number of results returned by searchVault.
  searchMaxResults: number;
  // Per-excerpt character cap for searchVault content matches.
  searchExcerptChars: number;
  // Include files under hidden folders (starting with `.`) in searchVault
  // and listFilesInFolder. Default false to skip .obsidian and friends.
  includeHiddenFolders: boolean;
}

export const DEFAULT_SETTINGS: ClaudeCodeIdeSettings = {
  contentCharCap: 50_000,
  searchMaxResults: 50,
  searchExcerptChars: 200,
  includeHiddenFolders: false,
};

export class ClaudeCodeIdeSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: ClaudeCodeIdePlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Claude Code IDE" });
    containerEl.createEl("p", {
      text:
        "These settings tune the Obsidian-native MCP tools the plugin exposes to Claude Code. " +
        "Wire-layer settings (port, auth) are managed automatically.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Active-note content cap")
      .setDesc(
        "Maximum characters returned by getActiveNoteContent. Longer notes are truncated and flagged with truncated: true.",
      )
      .addText((t) =>
        t
          .setPlaceholder("50000")
          .setValue(String(this.plugin.settings.contentCharCap))
          .onChange(async (v) => {
            const n = Number.parseInt(v, 10);
            if (Number.isFinite(n) && n > 0) {
              this.plugin.settings.contentCharCap = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("searchVault max results")
      .setDesc("Hard cap on filename + content hits returned per search.")
      .addText((t) =>
        t
          .setPlaceholder("50")
          .setValue(String(this.plugin.settings.searchMaxResults))
          .onChange(async (v) => {
            const n = Number.parseInt(v, 10);
            if (Number.isFinite(n) && n > 0) {
              this.plugin.settings.searchMaxResults = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("searchVault excerpt length")
      .setDesc("Characters of surrounding context per content match.")
      .addText((t) =>
        t
          .setPlaceholder("200")
          .setValue(String(this.plugin.settings.searchExcerptChars))
          .onChange(async (v) => {
            const n = Number.parseInt(v, 10);
            if (Number.isFinite(n) && n >= 40) {
              this.plugin.settings.searchExcerptChars = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Include hidden folders")
      .setDesc(
        "When off, files under folders starting with '.' (like .obsidian) are excluded from searchVault and listFilesInFolder.",
      )
      .addToggle((tg) =>
        tg
          .setValue(this.plugin.settings.includeHiddenFolders)
          .onChange(async (v) => {
            this.plugin.settings.includeHiddenFolders = v;
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl("h3", { text: "Connection" });
    const conn = containerEl.createDiv({ cls: "setting-item-description" });
    conn.createEl("div", {
      text: `WebSocket: ${this.plugin.connectionInfo()}`,
    });
    conn.createEl("div", {
      text: "Lockfile is rewritten on every plugin enable (port is OS-picked).",
    });
  }
}
