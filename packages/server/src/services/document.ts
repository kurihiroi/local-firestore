import type { DocumentData, DocumentMetadata } from "@local-firestore/shared";
import { isFieldValueSentinel } from "@local-firestore/shared";
import type { DocumentRepository } from "../storage/repository.js";
import { generateDocumentId } from "../utils/id.js";
import { parseDocumentPath } from "../utils/path.js";

export class DocumentService {
  constructor(private repo: DocumentRepository) {}

  getDocument(path: string): DocumentMetadata | undefined {
    return this.repo.get(path);
  }

  setDocument(path: string, data: DocumentData): DocumentMetadata {
    const { collectionPath, documentId } = parseDocumentPath(path);
    const resolvedData = this.resolveFieldValues(data, this.repo.get(path)?.data);

    return this.repo.set({
      path,
      collectionPath,
      documentId,
      data: resolvedData,
    });
  }

  addDocument(collectionPath: string, data: DocumentData): DocumentMetadata {
    const documentId = generateDocumentId();
    const path = `${collectionPath}/${documentId}`;
    const resolvedData = this.resolveFieldValues(data, undefined);

    return this.repo.set({
      path,
      collectionPath,
      documentId,
      data: resolvedData,
    });
  }

  updateDocument(path: string, data: DocumentData): DocumentMetadata {
    const existing = this.repo.get(path);
    if (!existing) {
      throw new DocumentNotFoundError(path);
    }

    const mergedData = { ...existing.data };
    const resolvedUpdates = this.resolveFieldValues(data, existing.data);

    for (const [key, value] of Object.entries(resolvedUpdates)) {
      if (value === "$$__DELETE__$$") {
        delete mergedData[key];
      } else {
        mergedData[key] = value;
      }
    }

    const { collectionPath, documentId } = parseDocumentPath(path);
    return this.repo.set({
      path,
      collectionPath,
      documentId,
      data: mergedData,
    });
  }

  deleteDocument(path: string): boolean {
    return this.repo.delete(path);
  }

  /**
   * FieldValueセンチネルをサーバーサイドで実際の値に解決する
   */
  private resolveFieldValues(
    data: DocumentData,
    existingData: DocumentData | undefined,
  ): DocumentData {
    const resolved: DocumentData = {};

    for (const [key, value] of Object.entries(data)) {
      if (isFieldValueSentinel(value)) {
        switch (value.type) {
          case "serverTimestamp": {
            const now = new Date();
            resolved[key] = {
              __type: "timestamp",
              value: {
                seconds: Math.floor(now.getTime() / 1000),
                nanoseconds: (now.getTime() % 1000) * 1_000_000,
              },
            };
            break;
          }
          case "deleteField":
            resolved[key] = "$$__DELETE__$$";
            break;
          case "increment": {
            const current = (existingData?.[key] as number) ?? 0;
            resolved[key] = current + (value.value as number);
            break;
          }
          case "arrayUnion": {
            const currentArr = (existingData?.[key] as unknown[]) ?? [];
            const toAdd = value.value as unknown[];
            resolved[key] = [...currentArr, ...toAdd.filter((v) => !currentArr.includes(v))];
            break;
          }
          case "arrayRemove": {
            const currentArr2 = (existingData?.[key] as unknown[]) ?? [];
            const toRemove = value.value as unknown[];
            resolved[key] = currentArr2.filter((v) => !toRemove.includes(v));
            break;
          }
        }
      } else {
        resolved[key] = value;
      }
    }

    return resolved;
  }
}

export class DocumentNotFoundError extends Error {
  readonly code = "not-found";
  constructor(path: string) {
    super(`Document not found: ${path}`);
    this.name = "DocumentNotFoundError";
  }
}
