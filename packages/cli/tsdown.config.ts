import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts", bin: "src/bin.ts", analyze: "src/analysis/worker-entry.ts", generation: "src/local/generation-entry.ts", provision: "src/provision/provision-entry.ts" },
  format: "esm",
  platform: "node",
  fixedExtension: false,
  dts: true,
  sourcemap: false,
  clean: true
});