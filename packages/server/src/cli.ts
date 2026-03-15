import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createDatabase } from "./storage/sqlite.js";

const port = Number(process.env.PORT) || 8080;
const dbPath = process.env.DB_PATH || "local-firestore.db";

const db = createDatabase(dbPath);
const app = createApp(db);

console.log(`Local Firestore server starting on port ${port}`);
console.log(`Database: ${dbPath}`);

serve({ fetch: app.fetch, port }, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
