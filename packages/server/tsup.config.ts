import { defineConfig } from "tsup";

// splitting は ESM のみ有効化する（index/cli 間で共有コードをチャンク化する）。
// CJS は tsup/esbuild の code splitting が未対応のため無効のまま。
export default defineConfig([
  {
    entry: ["src/index.ts", "src/cli.ts"],
    format: ["esm"],
    dts: { entry: ["src/index.ts"] },
    splitting: true,
    sourcemap: true,
    clean: true,
    outDir: "dist",
  },
  {
    entry: ["src/index.ts", "src/cli.ts"],
    format: ["cjs"],
    dts: { entry: ["src/index.ts"] },
    splitting: false,
    sourcemap: true,
    clean: false,
    outDir: "dist",
  },
]);
