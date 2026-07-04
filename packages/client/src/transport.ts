import type { FirestoreErrorCode } from "@local-firestore/shared";

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

export class HttpTransport {
  private baseUrl: string;
  private wsUrl: string;
  private authTokenProvider?: AuthTokenProvider;

  /**
   * @param basePath 全リクエストパスに付与するプレフィックス
   *                 （マルチデータベース時の `/databases/:databaseId` など）
   * @param authTokenProvider リクエストごとに認証トークンを返す関数
   */
  constructor(
    host: string,
    port: number,
    ssl = false,
    basePath = "",
    authTokenProvider?: AuthTokenProvider,
  ) {
    const protocol = ssl ? "https" : "http";
    this.baseUrl = `${protocol}://${host}:${port}${basePath}`;
    const wsProtocol = ssl ? "wss" : "ws";
    this.wsUrl = `${wsProtocol}://${host}:${port}`;
    this.authTokenProvider = authTokenProvider;
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
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: await this.buildHeaders(false),
    });
    if (!res.ok) {
      await this.handleError(res);
    }
    return res.json() as Promise<T>;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: await this.buildHeaders(true),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      await this.handleError(res);
    }
    return res.json() as Promise<T>;
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "PUT",
      headers: await this.buildHeaders(true),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      await this.handleError(res);
    }
    return res.json() as Promise<T>;
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "PATCH",
      headers: await this.buildHeaders(true),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      await this.handleError(res);
    }
    return res.json() as Promise<T>;
  }

  async delete<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "DELETE",
      headers: await this.buildHeaders(false),
    });
    if (!res.ok) {
      await this.handleError(res);
    }
    return res.json() as Promise<T>;
  }

  private async handleError(res: Response): Promise<never> {
    const body = await res.json().catch(() => ({}));
    const code = ((body as Record<string, string>).code ?? "unknown") as FirestoreErrorCode;
    const message = (body as Record<string, string>).message ?? res.statusText;
    throw new FirestoreError(code, message);
  }
}

/**
 * Firebase互換のFirestoreErrorクラス
 *
 * firebase/firestoreの `FirestoreError` と同じインターフェースを提供する。
 */
export class FirestoreError extends Error {
  readonly name = "FirestoreError";
  constructor(
    readonly code: FirestoreErrorCode,
    message: string,
  ) {
    super(message);
  }
}
