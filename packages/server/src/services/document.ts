import type {
  DocumentData,
  DocumentMetadata,
  FirestoreErrorCode,
  SetOptions,
} from "@local-firestore/shared";
import {
  applySetMutation,
  applyUpdateMutation,
  createServerMutationContext,
  validateDocumentWrite,
} from "@local-firestore/shared";
import type { DocumentRepository } from "../storage/repository.js";
import { generateDocumentId } from "../utils/id.js";
import { parseDocumentPath } from "../utils/path.js";

/**
 * ドキュメントの書き込み・読み取りサービス
 *
 * ミューテーションの適用セマンティクス（センチネル解決 / merge / ドット記法 /
 * deleteField / Timestamp 切り捨て）は shared の mutation-applier に実装されており、
 * クライアントのレイテンシ補償（ローカルビュー合成）と共有される。
 */
export class DocumentService {
  private mutationContext = createServerMutationContext();

  constructor(private repo: DocumentRepository) {}

  getDocument(path: string): DocumentMetadata | undefined {
    return this.repo.get(path);
  }

  setDocument(path: string, data: DocumentData, options?: SetOptions): DocumentMetadata {
    const { collectionPath, documentId } = parseDocumentPath(path);
    const existing = this.repo.get(path);
    const finalData = applySetMutation(existing?.data ?? null, data, options, this.mutationContext);

    validateDocumentWrite(path, finalData);
    return this.repo.set({
      path,
      collectionPath,
      documentId,
      data: finalData,
    });
  }

  addDocument(collectionPath: string, data: DocumentData): DocumentMetadata {
    const documentId = generateDocumentId();
    const path = `${collectionPath}/${documentId}`;
    const finalData = applySetMutation(null, data, undefined, this.mutationContext);

    validateDocumentWrite(path, finalData);
    return this.repo.set({
      path,
      collectionPath,
      documentId,
      data: finalData,
    });
  }

  updateDocument(path: string, data: DocumentData): DocumentMetadata {
    const existing = this.repo.get(path);
    if (!existing) {
      throw new DocumentNotFoundError(path);
    }

    const finalData = applyUpdateMutation(existing.data, data, this.mutationContext);

    validateDocumentWrite(path, finalData);
    const { collectionPath, documentId } = parseDocumentPath(path);
    return this.repo.set({
      path,
      collectionPath,
      documentId,
      data: finalData,
    });
  }

  deleteDocument(path: string): boolean {
    return this.repo.delete(path);
  }
}

export class DocumentNotFoundError extends Error {
  readonly code: FirestoreErrorCode = "not-found";
  constructor(path: string) {
    super(`Document not found: ${path}`);
    this.name = "DocumentNotFoundError";
  }
}
