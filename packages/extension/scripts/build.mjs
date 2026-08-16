import { build } from "esbuild";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: ["src/extension.ts"],
  outfile: "out/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  alias: {
    "@stashboard/core": path.resolve(dir, "../../core/src/index.ts"),
  },
  sourcemap: true,
  logLevel: "info",
});
