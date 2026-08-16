import { build } from "esbuild";

await build({
  entryPoints: ["src/git-stashboard.ts"],
  outfile: "dist/git-stashboard.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  sourcemap: true,
  logLevel: "info",
});
