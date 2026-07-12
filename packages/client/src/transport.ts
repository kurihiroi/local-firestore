import type { FirestoreErrorCode } from "@local-firestore/shared";
import { logDebug } from "./logger.js";

/**
 * 認証トークンプロバイダー
 *
 * リクエストごとに呼び出され、返されたトークンが
 * `Authorization: Bearer <token>` ヘッダーとして送信される。
 * Firebase Auth と連携する場合は `getAuth().currentUser?.getIdToken()` を返す。
 */
export type AuthTokenProvider = () =>
  | string
  | null
  | undefined
  | Promise<string | null | undefined>;

/** HTTP リクエストのリトライ・タイムアウト設定 */
export interface TransportRetryOptions {
  /** 1リクエストあたりの最大試行回数（初回を含む） */
  maxAttempts?: number;
  /** リトライの初期遅延（ミリ秒） */
  initialDelayMs?: number;
  /** リトライの最大遅延（ミリ秒） */
  maxDelayMs?: number;
  /** バックオフ倍率 */
  backoffMultiplier?: number;
  /** 1試行あたりのタイムアウト（ミリ秒） */
  requestTimeoutMs?: number;
}

const DEFAULT_RETRY_OPTIONS: Required<TransportRetryOptions> = {
  maxAttempts: 3,
  initialDelayMs: 250,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  requestTimeoutMs: 30000,
};

/** 一過性（リトライで解消しうる）のエラーコード */
const TRANSIENT_ERROR_CODES: ReadonlySet<FirestoreErrorCode> = new Set([
  "unavailable",
  "deadline-exceeded",
]);

/**
 * リトライで解消しうる一過性エラーかどうか
 *
 * ネットワーク断・タイムアウト・サーバー一時停止（503 等）が該当する。
 * LocalStore の mutation 再送判定にも使われる。
 */
export function isTransientError(err: unknown): boolean {
  return err instanceof FirestoreError && TRANSIENT_ERROR_CODES.has(err.code);
}

/** エラーレスポンスボディに code がない場合の HTTP ステータスからのフォールバック */
function statusToErrorCode(status: number): FirestoreErrorCode {
  switch (status) {
    case 429:
      return "resource-exhausted";
    case 502:
    case 503:
      return "unavailable";
    case 504:
      return "deadline-exceeded";
    default:
      return "unknown";
  }
}

/** リクエスト単位のオプション */
interface RequestOptions {
  /**
   * false でトランスポート層のリトライを無効化する。
   * 再送すると二重適用になりうるリクエスト（トランザクション commit）で使う。
   */
  retry?: boolean;
}

export class HttpTransport {
  private baseUrl: string;
  private wsUrl: string;
  private authTokenProvider?: AuthTokenProvider;
  private retryOptions: Required<TransportRetryOptions>;

  /**
   * @param basePath 全リクエストパスに付与するプレフィックス
   *                 （マルチデータベース時の `/databases/:databaseId` など）
   * @param authTokenProvider リクエストごとに認証トークンを返す関数
   * @param retryOptions リトライ・タイムアウト設定（省略時はデフォルト値）
   */
  constructor(
    host: string,
    port: number,
    ssl = false,
    basePath = "",
    authTokenProvider?: AuthTokenProvider,
    retryOptions?: TransportRetryOptions,
  ) {
    const protocol = ssl ? "https" : "http";
    this.baseUrl = `${protocol}://${host}:${port}${basePath}`;
    const wsProtocol = ssl ? "wss" : "ws";
    this.wsUrl = `${wsProtocol}://${host}:${port}`;
    this.authTokenProvider = authTokenProvider;
    this.retryOptions = { ...DEFAULT_RETRY_OPTIONS, ...retryOptions };
  }

  getWebSocketUrl(): string {
    return this.wsUrl;
  }

  /**
   * 認証トークンを取得する（未設定時は null）
   *
   * WebSocket の subscribe メッセージなど、HTTP ヘッダー以外で
   * トークンを送信する経路で使用する。
   */
  async getAuthToken(): Promise<string | null> {
    if (!this.authTokenProvider) return null;
    const token = await this.authTokenProvider();
    return token ?? null;
  }

  /** 設定済みの認証トークンプロバイダーを返す（インスタンス再構築用） */
  getAuthTokenProvider(): AuthTokenProvider | undefined {
    return this.authTokenProvider;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private async buildHeaders(withContentType: boolean): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    if (withContentType) {
      headers["Content-Type"] = "application/json";
    }
    if (this.authTokenProvider) {
      const token = await this.authTokenProvider();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
    }
    return headers;
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  async post<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", path, body, options);
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  /**
   * 一過性エラー（unavailable / deadline-exceeded）を指数バックオフ付きで
   * リトライしながらリクエストを実行する。
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    const retryEnabled = options?.retry !== false;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.requestOnce<T>(method, path, body);
      } catch (err) {
        if (!retryEnabled || attempt >= this.retryOptions.maxAttempts || !isTransientError(err)) {
          throw err;
        }
        const delay = this.backoffDelay(attempt);
        logDebug(
          `${method} ${path} failed transiently (attempt ${attempt}/${this.retryOptions.maxAttempts}), retrying in ${Math.round(delay)}ms: ${String(err)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private async requestOnce<T>(method: string, path: string, body?: unknown): Promise<T> {
    const hasBody = body !== undefined;
    const headers = await this.buildHeaders(hasBody);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.retryOptions.requestTimeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(hasBody ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      // ネットワーク層の失敗を FirestoreError に正規化する（生エラーを漏らさない）
      if (controller.signal.aborted) {
        throw new FirestoreError(
          "deadline-exceeded",
          `Request timed out after ${this.retryOptions.requestTimeoutMs}ms: ${method} ${path}`,
        );
      }
      throw new FirestoreError(
        "unavailable",
        `Network request failed: ${method} ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      await this.handleError(res);
    }
    return res.json() as Promise<T>;
  }

  /** ジッター付き指数バックオフの遅延を計算する（0.5〜1.0倍で分散） */
  private backoffDelay(attempt: number): number {
    const { initialDelayMs, backoffMultiplier, maxDelayMs } = this.retryOptions;
    const base = Math.min(initialDelayMs * backoffMultiplier ** (attempt - 1), maxDelayMs);
    return base * (0.5 + Math.random() * 0.5);
  }

  private async handleError(res: Response): Promise<never> {
    const body = await res.json().catch(() => ({}));
    const code = ((body as Record<string, string>).code ??
      statusToErrorCode(res.status)) as FirestoreErrorCode;
    const message = (body as Record<string, string>).message ?? res.statusText;
    throw new FirestoreError(code, message);
  }
}

/**
 * `firebase/app` の `FirebaseError` 互換クラス
 *
 * 本家同様 `name` は "FirebaseError"。`err instanceof FirebaseError` /
 * `err.name === "FirebaseError"` での判定コードが動くよう、
 * FirestoreError はこのクラスを継承する。
 */
export class FirebaseError extends Error {
  /** 本家 FirebaseError と同じく、サブクラスでも常に "FirebaseError" */
  readonly name: string = "FirebaseError";

  constructor(
    readonly code: string,
    message: string,
    public customData?: Record<string, unknown>,
  ) {
    super(message);
    // Error のサブクラス化で instanceof が壊れないようにする（本家と同じ対策）
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Firebase互換のFirestoreErrorクラス
 *
 * firebase/firestoreの `FirestoreError` と同じインターフェースを提供する
 * （本家同様 `FirebaseError` を継承し、`name` は "FirebaseError"）。
 */
export class FirestoreError extends FirebaseError {
  declare readonly code: FirestoreErrorCode;

  // biome-ignore lint/complexity/noUselessConstructor: code 引数を FirestoreErrorCode に絞るための再宣言
  constructor(code: FirestoreErrorCode, message: string) {
    super(code, message);
  }
}
