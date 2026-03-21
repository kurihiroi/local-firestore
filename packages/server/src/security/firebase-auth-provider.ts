import type { AuthProvider } from "./auth-provider.js";
import type { AuthContext } from "./rules-engine.js";

/**
 * Firebase Auth の verifyIdToken が返すデコード済みトークンの最小型定義
 */
interface DecodedIdToken {
  uid: string;
  [key: string]: unknown;
}

/**
 * Firebase Admin Auth の最小インターフェース
 * firebase-admin が optionalDependencies のため、直接 import せずインターフェースで抽象化する
 */
interface FirebaseAuth {
  verifyIdToken(idToken: string): Promise<DecodedIdToken>;
}

/**
 * Firebase Auth 認証プロバイダー
 * Firebase Admin SDK を使って ID トークン（JWT）を検証する
 */
export class FirebaseAuthProvider implements AuthProvider {
  constructor(private auth: FirebaseAuth) {}

  async extractAuth(authHeader: string | undefined): Promise<AuthContext | null> {
    if (!authHeader) return null;
    const match = authHeader.match(/^Bearer\s+(.+)$/);
    if (!match) return null;

    const idToken = match[1];

    try {
      const decoded = await this.auth.verifyIdToken(idToken);
      return {
        uid: decoded.uid,
        token: decoded as Record<string, unknown>,
      };
    } catch {
      return null;
    }
  }
}
