import Database from "better-sqlite3";
import { initSchema } from "./schema.js";

export function createDatabase(path: string = ":memory:"): Database.Database {
  const db = new Database(path);

  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  initSchema(db);

  return db;
}
