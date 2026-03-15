import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@local-firestore/client": path.resolve(__dirname, "../../packages/client/src/index.ts"),
      "@local-firestore/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts"),
    },
  },
});
