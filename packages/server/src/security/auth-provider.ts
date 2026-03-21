import type { AuthContext } from "./rules-engine.js";

/**
 * 認証プロバイダーインターフェース
 * Authorization ヘッダーから AuthContext を抽出する
 */
export interface AuthProvider {
  extractAuth(authHeader: string | undefined): Promise<AuthContext | null>;
}

/**
 * ローカル認証プロバイダー
 * Bearer <uid> または Bearer <uid>:<json_claims> 形式を解析する
 * トークン検証は行わない（開発・テスト用）
 */
export class LocalAuthProvider implements AuthProvider {
  async extractAuth(authHeader: string | undefined): Promise<AuthContext | null> {
    if (!authHeader) return null;
    const match = authHeader.match(/^Bearer\s+(.+)$/);
    if (!match) return null;

    const payload = match[1];

    // uid:json_claims 形式のサポート
    const colonIndex = payload.indexOf(":");
    if (colonIndex > 0) {
      const uid = payload.slice(0, colonIndex);
      const claimsStr = payload.slice(colonIndex + 1);
      try {
        const claims = JSON.parse(claimsStr) as Record<string, unknown>;
        return { uid, token: claims };
      } catch {
        // JSON パース失敗時は uid のみ
        return { uid };
      }
    }

    return { uid: payload };
  }
}
