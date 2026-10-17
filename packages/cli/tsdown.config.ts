import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/bin.ts"],
  format: "esm",
  platform: "node",
  fixedExtension: false,
  dts: true,
  sourcemap: false,
  clean: true
});