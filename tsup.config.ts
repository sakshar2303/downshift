import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  clean: true,
  dts: false,
  sourcemap: true,
  splitting: false,
  // tsup strips the "node:" prefix by default, which turns the built-in
  // "node:sqlite" into a package called "sqlite" that does not exist.
  removeNodeProtocol: false,
  banner: { js: "#!/usr/bin/env node" },
});
