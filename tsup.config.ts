import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli/bin.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  sourcemap: true,
  dts: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
