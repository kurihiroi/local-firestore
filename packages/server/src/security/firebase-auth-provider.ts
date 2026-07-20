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

/** FirebaseAuthProvider のオプション */
export interface FirebaseAuthProviderOptions {
  /**
   * トークン検証失敗時に呼ばれるフック（ログ / メトリクス用）。
   * 未指定時は console.error へ出力する。
   */
  onVerificationFailure?: (message: string) => void;
}

/**
 * Firebase Auth 認証プロバイダー
 * Firebase Admin SDK を使って ID トークン（JWT）を検証する
 */
export class FirebaseAuthProvider implements AuthProvider {
  private failures = 0;

  constructor(
    private auth: FirebaseAuth,
    private options: FirebaseAuthProviderOptions = {},
  ) {}

  /** トークン検証失敗の累計（メトリクス / 監視用） */
  get verificationFailureCount(): number {
    return this.failures;
  }

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
    } catch (err) {
      // トークンが「無い」のではなく「検証に失敗した」ケース。
      // 静かに匿名へ落とすと認証系の障害（鍵ローテーション失敗・
      // プロジェクト設定ミス等）が見えなくなるため、必ず可視化する
      this.failures++;
      const message = `Firebase ID token verification failed (falling back to anonymous): ${
        err instanceof Error ? err.message : String(err)
      }`;
      if (this.options.onVerificationFailure) {
        this.options.onVerificationFailure(message);
      } else {
        console.error(message);
      }
      return null;
    }
  }
}
