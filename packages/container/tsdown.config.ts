import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  fixedExtension: false,
  dts: true,
  sourcemap: false,
  clean: true,
  // Bun's built-in modules exist only at run time; @holqa/local runs on Bun.
  deps: { neverBundle: [/^bun:/] }
});