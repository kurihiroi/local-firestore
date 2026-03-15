import type Database from "better-sqlite3";
import type { DocumentData, DocumentMetadata } from "@local-firestore/shared";

export class DocumentRepository {
  private stmts: {
    get: Database.Statement;
    insert: Database.Statement;
    update: Database.Statement;
    delete: Database.Statement;
    listCollection: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      get: db.prepare("SELECT * FROM documents WHERE path = ?"),
      insert: db.prepare(`
        INSERT INTO documents (path, collection_path, document_id, data, version, create_time, update_time)
        VALUES (@path, @collectionPath, @documentId, @data, 1, @createTime, @updateTime)
      `),
      update: db.prepare(`
        UPDATE documents
        SET data = @data, version = version + 1, update_time = @updateTime
        WHERE path = @path
      `),
      delete: db.prepare("DELETE FROM documents WHERE path = ?"),
      listCollection: db.prepare("SELECT * FROM documents WHERE collection_path = ?"),
    };
  }

  get(path: string): DocumentMetadata | undefined {
    const row = this.stmts.get.get(path) as RawRow | undefined;
    return row ? toMetadata(row) : undefined;
  }

  set(meta: {
    path: string;
    collectionPath: string;
    documentId: string;
    data: DocumentData;
  }): DocumentMetadata {
    const now = new Date().toISOString();
    const dataJson = JSON.stringify(meta.data);

    const existing = this.get(meta.path);
    if (existing) {
      this.stmts.update.run({ path: meta.path, data: dataJson, updateTime: now });
      return {
        ...meta,
        data: meta.data,
        version: existing.version + 1,
        createTime: existing.createTime,
        updateTime: now,
      };
    }

    this.stmts.insert.run({
      path: meta.path,
      collectionPath: meta.collectionPath,
      documentId: meta.documentId,
      data: dataJson,
      createTime: now,
      updateTime: now,
    });
    return {
      ...meta,
      data: meta.data,
      version: 1,
      createTime: now,
      updateTime: now,
    };
  }

  delete(path: string): boolean {
    const result = this.stmts.delete.run(path);
    return result.changes > 0;
  }

  listCollection(collectionPath: string): DocumentMetadata[] {
    const rows = this.stmts.listCollection.all(collectionPath) as RawRow[];
    return rows.map(toMetadata);
  }
}

interface RawRow {
  path: string;
  collection_path: string;
  document_id: string;
  data: string;
  version: number;
  create_time: string;
  update_time: string;
}

function toMetadata(row: RawRow): DocumentMetadata {
  return {
    path: row.path,
    collectionPath: row.collection_path,
    documentId: row.document_id,
    data: JSON.parse(row.data) as DocumentData,
    version: row.version,
    createTime: row.create_time,
    updateTime: row.update_time,
  };
}
