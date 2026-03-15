/**
 * ドキュメントパスからコレクションパスとドキュメントIDを抽出する
 * 例: "users/alice" → { collectionPath: "users", documentId: "alice" }
 * 例: "users/alice/posts/post1" → { collectionPath: "users/alice/posts", documentId: "post1" }
 */
export function parseDocumentPath(path: string): {
  collectionPath: string;
  documentId: string;
} {
  const segments = path.split("/");
  if (segments.length < 2 || segments.length % 2 !== 0) {
    throw new Error(`Invalid document path: "${path}". Document paths must have an even number of segments.`);
  }
  return {
    collectionPath: segments.slice(0, -1).join("/"),
    documentId: segments[segments.length - 1],
  };
}

/**
 * コレクションパスかどうかを検証する（奇数セグメント）
 */
export function isCollectionPath(path: string): boolean {
  const segments = path.split("/");
  return segments.length > 0 && segments.length % 2 === 1;
}

/**
 * ドキュメントパスかどうかを検証する（偶数セグメント）
 */
export function isDocumentPath(path: string): boolean {
  const segments = path.split("/");
  return segments.length >= 2 && segments.length % 2 === 0;
}
