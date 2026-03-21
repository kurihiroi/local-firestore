import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@local-firestore/client": resolve(__dirname, "../client/src/index.ts"),
      "@local-firestore/server": resolve(__dirname, "../server/src/index.ts"),
      "@local-firestore/shared": resolve(__dirname, "../shared/src/index.ts"),
    },
  },
  test: {
    testTimeout: 15000,
    fileParallelism: false,
  },
});
