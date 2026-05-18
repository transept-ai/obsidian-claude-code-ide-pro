import esbuild from "esbuild";
import { builtinModules } from "module";

const production = process.argv.includes("production");

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "es2022",
  outfile: "main.js",
  sourcemap: production ? false : "inline",
  minify: production,
  treeShaking: true,
  logLevel: "info",
  // Obsidian + CodeMirror + electron + node builtins are provided by the host
  external: [
    "obsidian",
    "electron",
    // @codemirror/state and @codemirror/view MUST be external — they hold
    // module-level singletons that break if loaded twice (Obsidian's editors
    // would stop responding). @codemirror/merge builds on top but isn't
    // exposed by Obsidian, so bundle that one.
    "@codemirror/state",
    "@codemirror/view",
    "@codemirror/language",
    "@codemirror/search",
    "@codemirror/commands",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
  ],
});

if (production) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
}
