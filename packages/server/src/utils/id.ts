import { nanoid } from "nanoid";

/** Firestore互換の20文字のドキュメントIDを生成する */
export function generateDocumentId(): string {
  return nanoid(20);
}
