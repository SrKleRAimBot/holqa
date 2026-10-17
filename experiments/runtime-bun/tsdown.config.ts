import { defineConfig } from "tsdown";

export default defineConfig({
  // The worker entry is loaded by URL from the bundled runtime, so it must be a separate file next to index.js.
  entry: ["src/index.ts", "src/worker-entry.ts"],
  format: "esm",
  platform: "node",
  // Emit .js/.d.ts so the files match the package.json exports map.
  fixedExtension: false,
  dts: true,
  sourcemap: false,
  clean: true
});