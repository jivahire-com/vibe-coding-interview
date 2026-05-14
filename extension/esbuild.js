const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");
const watch = process.argv.includes("--watch");

// Copy webview-ui-toolkit bundle into dist so it can be served as a webview URI
const toolkitSrc = path.join(__dirname, "node_modules/@vscode/webview-ui-toolkit/dist/toolkit.min.js");
const toolkitDst = path.join(__dirname, "dist/toolkit.min.js");
if (!fs.existsSync("dist")) fs.mkdirSync("dist");
fs.copyFileSync(toolkitSrc, toolkitDst);

const ctx = esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  sourcemap: true,
  minify: false,
});

ctx.then(c => watch ? c.watch() : c.rebuild().then(() => c.dispose()));
