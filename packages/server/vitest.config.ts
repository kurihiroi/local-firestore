import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@local-firestore/shared": path.resolve(__dirname, "../shared/src/index.ts"),
    },
  },
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
  },
});
