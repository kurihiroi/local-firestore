import type { FirestoreErrorCode } from "@local-firestore/shared";

export class HttpTransport {
  private baseUrl: string;
  private wsUrl: string;

  constructor(host: string, port: number, ssl = false) {
    const protocol = ssl ? "https" : "http";
    this.baseUrl = `${protocol}://${host}:${port}`;
    const wsProtocol = ssl ? "wss" : "ws";
    this.wsUrl = `${wsProtocol}://${host}:${port}`;
  }

  getWebSocketUrl(): string {
    return this.wsUrl;
  }

  async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) {
      await this.handleError(res);
    }
    return res.json() as Promise<T>;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
      headers: { "Content-Type": "application/json" },
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
      headers: { "Content-Type": "application/json" },
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
