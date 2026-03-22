import type {
  AddDocumentRequest,
  AddDocumentResponse,
  DeleteDocumentResponse,
  DocumentMetadata,
  ErrorResponse,
  GetDocumentResponse,
  SetDocumentRequest,
  UpdateDocumentRequest,
} from "@local-firestore/shared";
import { Hono } from "hono";
import type { DocumentService } from "../services/document.js";
import { DocumentNotFoundError } from "../services/document.js";
import { isCollectionPath, isDocumentPath } from "../utils/path.js";

export function createDocumentRoutes(
  documentService: DocumentService,
  onDocumentChange?: (path: string, oldDocument?: DocumentMetadata) => void,
): Hono {
  const app = new Hono();

  // GET /docs/:path - ドキュメント取得
  app.get("/docs/*", (c) => {
    const path = c.req.path.replace("/docs/", "");
    if (!isDocumentPath(path)) {
      return c.json<ErrorResponse>(
        { code: "invalid-argument", message: "Invalid document path" },
        400,
      );
    }

    const doc = documentService.getDocument(path);
    const response: GetDocumentResponse = {
      exists: !!doc,
      path,
      data: doc?.data ?? null,
      createTime: doc?.createTime ?? null,
      updateTime: doc?.updateTime ?? null,
    };
    return c.json(response);
  });

  // POST /docs - ドキュメント追加（addDoc）
  app.post("/docs", async (c) => {
    const body = await c.req.json<AddDocumentRequest>();
    if (!isCollectionPath(body.collectionPath)) {
      return c.json<ErrorResponse>(
        { code: "invalid-argument", message: "Invalid collection path" },
        400,
      );
    }

    const meta = documentService.addDocument(body.collectionPath, body.data);
    onDocumentChange?.(meta.path, undefined);
    const response: AddDocumentResponse = {
      path: meta.path,
      documentId: meta.documentId,
    };
    return c.json(response, 201);
  });

  // PUT /docs/:path - ドキュメント作成/上書き（setDoc）
  app.put("/docs/*", async (c) => {
    const path = c.req.path.replace("/docs/", "");
    if (!isDocumentPath(path)) {
      return c.json<ErrorResponse>(
        { code: "invalid-argument", message: "Invalid document path" },
        400,
      );
    }

    const oldDoc = documentService.getDocument(path);
    const body = await c.req.json<SetDocumentRequest>();
    documentService.setDocument(path, body.data, body.options);
    onDocumentChange?.(path, oldDoc);
    return c.json({ success: true });
  });

  // PATCH /docs/:path - ドキュメント更新（updateDoc）
  app.patch("/docs/*", async (c) => {
    const path = c.req.path.replace("/docs/", "");
    if (!isDocumentPath(path)) {
      return c.json<ErrorResponse>(
        { code: "invalid-argument", message: "Invalid document path" },
        400,
      );
    }

    try {
      const oldDoc = documentService.getDocument(path);
      const body = await c.req.json<UpdateDocumentRequest>();
      documentService.updateDocument(path, body.data);
      onDocumentChange?.(path, oldDoc);
      return c.json({ success: true });
    } catch (e) {
      if (e instanceof DocumentNotFoundError) {
        return c.json<ErrorResponse>({ code: "not-found", message: e.message }, 404);
      }
      throw e;
    }
  });

  // DELETE /docs/:path - ドキュメント削除
  app.delete("/docs/*", (c) => {
    const path = c.req.path.replace("/docs/", "");
    if (!isDocumentPath(path)) {
      return c.json<ErrorResponse>(
        { code: "invalid-argument", message: "Invalid document path" },
        400,
      );
    }

    const oldDoc = documentService.getDocument(path);
    documentService.deleteDocument(path);
    onDocumentChange?.(path, oldDoc);
    const response: DeleteDocumentResponse = { success: true };
    return c.json(response);
  });

  return app;
}
