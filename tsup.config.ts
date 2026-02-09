import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
  external: [
    "better-sqlite3",
    "tree-sitter",
    "tree-sitter-typescript",
    "tree-sitter-javascript",
  ],
});
