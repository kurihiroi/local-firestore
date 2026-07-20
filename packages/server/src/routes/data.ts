import type {
  ExportedDocument,
  ExportResponse,
  ImportRequest,
  ImportResponse,
} from "@local-firestore/shared";
import { Hono } from "hono";
import { normalizeLegacyDocumentData } from "../migration/normalize.js";
import type { DocumentRepository } from "../storage/repository.js";
import { parseDocumentPath } from "../utils/path.js";

export function createDataRoutes(repo: DocumentRepository): Hono {
  const app = new Hono();

  // GET /export - 全ドキュメントをエクスポート
  // （単一トランザクション内で読み取り、スナップショット一貫性を保証する）
  app.get("/export", (c) => {
    const allDocs = repo.exportSnapshot();
    const documents: ExportedDocument[] = allDocs.map((doc) => ({
      path: doc.path,
      data: doc.data,
      createTime: doc.createTime,
      updateTime: doc.updateTime,
    }));

    const response: ExportResponse = {
      version: 1,
      exportedAt: new Date().toISOString(),
      documents,
    };

    return c.json(response);
  });

  // POST /import - ドキュメントをインポート
  app.post("/import", async (c) => {
    const body = await c.req.json<ImportRequest>();

    if (body.clean) {
      repo.deleteAll();
    }

    let imported = 0;
    for (const doc of body.documents) {
      const { collectionPath, documentId } = parseDocumentPath(doc.path);
      // 旧形式データ（素の {seconds, nanoseconds} マップ・ナノ秒精度 Timestamp）を
      // 現行形式へ変換する（migrate CLI と同じ正規化。export → import での移行経路）
      const { data } = normalizeLegacyDocumentData(doc.data);
      repo.set({
        path: doc.path,
        collectionPath,
        documentId,
        data,
      });
      imported++;
    }

    const response: ImportResponse = { imported };
    return c.json(response);
  });

  return app;
}
