import type {
  ExportedDocument,
  ExportResponse,
  ImportRequest,
  ImportResponse,
} from "@local-firestore/shared";
import { Hono } from "hono";
import type { DocumentRepository } from "../storage/repository.js";
import { parseDocumentPath } from "../utils/path.js";

export function createDataRoutes(repo: DocumentRepository): Hono {
  const app = new Hono();

  // GET /export - 全ドキュメントをエクスポート
  app.get("/export", (c) => {
    const allDocs = repo.listAll();
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
      repo.set({
        path: doc.path,
        collectionPath,
        documentId,
        data: doc.data,
      });
      imported++;
    }

    const response: ImportResponse = { imported };
    return c.json(response);
  });

  return app;
}
