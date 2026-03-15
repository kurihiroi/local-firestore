import type Database from "better-sqlite3";

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      path            TEXT PRIMARY KEY,
      collection_path TEXT NOT NULL,
      document_id     TEXT NOT NULL,
      data            TEXT NOT NULL,
      version         INTEGER NOT NULL DEFAULT 1,
      create_time     TEXT NOT NULL,
      update_time     TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_documents_collection
      ON documents(collection_path);

    CREATE INDEX IF NOT EXISTS idx_documents_collection_group
      ON documents(document_id, collection_path);
  `);
}
