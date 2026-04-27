const esbuild = require("esbuild");
const watch = process.argv.includes("--watch");

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
