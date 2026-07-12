/** 本家 Firestore の自動 ID と同じアルファベット（[A-Za-z0-9]） */
const AUTO_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Firestore互換の20文字のドキュメントIDを生成する
 *
 * 本家と同じ [A-Za-z0-9] の 20 桁（nanoid の `-` / `_` を含む
 * アルファベットは本家の ID 形式と異なるため使わない）。
 */
export function generateDocumentId(): string {
  let id = "";
  for (let i = 0; i < 20; i++) {
    id += AUTO_ID_ALPHABET[Math.floor(Math.random() * AUTO_ID_ALPHABET.length)];
  }
  return id;
}
