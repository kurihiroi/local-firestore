import { getConnectionManager, hasConnectionManager } from "./connection.js";
import { getLocalStore } from "./local-store.js";
import { logDebug } from "./logger.js";
import { setNetworkEnabled } from "./network-state.js";
import type { AuthTokenProvider } from "./transport.js";
import { FirestoreError, HttpTransport } from "./transport.js";
import type { Firestore } from "./types.js";

export type { LogLevel } from "./logger.js";
export { getLogLevel, setLogLevel } from "./logger.js";
export type { AuthTokenProvider } from "./transport.js";

export interface FirestoreSettings {
  host?: string;
  port?: number;
  ssl?: boolean;
  /**
   * 認証トークンプロバイダー
   *
   * リクエストごとに呼び出され、返したトークンが `Authorization: Bearer` ヘッダーで
   * 送信される。サーバーを `AUTH_PROVIDER=firebase` で起動すると Firebase Auth の
   * ID トークンとして検証され、セキュリティルールの `request.auth` に反映される。
   *
   * 使用例（Firebase Auth 連携）:
   * ```ts
   * const db = getFirestore({
   *   host: "localhost",
   *   port: 8080,
   *   authTokenProvider: () => getAuth().currentUser?.getIdToken() ?? null,
   * });
   * ```
   */
  authTokenProvider?: AuthTokenProvider;
  /**
   * true の場合、書き込みデータ内の undefined 値のプロパティを黙って除外する。
   * デフォルト（false）では undefined 値は invalid-argument エラーになる（本家同様）。
   */
  ignoreUndefinedProperties?: boolean;
}

const DEFAULT_SETTINGS = {
  host: "localhost",
  port: 8080,
  ssl: false,
} as const;

/** デフォルトデータベースのID */
const DEFAULT_DATABASE_ID = "(default)";

/** FirebaseApp ごとの Firestore インスタンスキャッシュ（databaseId 別） */
const appFirestoreInstances = new WeakMap<object, Map<string, Firestore>>();

/** 値が FirestoreSettings かどうか判定する */
function isFirestoreSettings(value: unknown): value is FirestoreSettings {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    "host" in obj ||
    "port" in obj ||
    "ssl" in obj ||
    "authTokenProvider" in obj ||
    "ignoreUndefinedProperties" in obj
  );
}

/**
 * 値が FirebaseApp かどうか判定する
 *
 * `firebase/app` の `FirebaseApp` は `name` / `options` プロパティを持つ。
 */
function isFirebaseApp(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.name === "string" && typeof obj.options === "object" && obj.options !== null;
}

/**
 * FirebaseApp から認証トークンを自動取得するプロバイダーを作成する
 *
 * `firebase/auth`（optional peer dependency）を遅延ロードし、
 * `getAuth(app).currentUser.getIdToken()` をリクエストごとに呼び出す。
 * `firebase` パッケージ未インストール時やサインイン前は null を返す。
 */
function createFirebaseAppTokenProvider(app: object): AuthTokenProvider {
  interface FirebaseAuthModule {
    getAuth: (app: object) => {
      currentUser: { getIdToken: () => Promise<string> } | null;
    };
  }

  let authModulePromise: Promise<FirebaseAuthModule | null> | null = null;
  const loadAuthModule = (): Promise<FirebaseAuthModule | null> => {
    if (!authModulePromise) {
      // バンドラーに事前解決させないため、モジュール指定子は変数経由で渡す
      const specifier = "firebase/auth";
      authModulePromise = (import(/* @vite-ignore */ specifier) as Promise<unknown>).then(
        (mod) => mod as FirebaseAuthModule,
        () => {
          logDebug("firebase/auth is not installed; auth token will not be sent");
          return null;
        },
      );
    }
    return authModulePromise;
  };

  return async () => {
    const mod = await loadAuthModule();
    if (!mod) return null;
    try {
      const auth = mod.getAuth(app);
      return (await auth.currentUser?.getIdToken()) ?? null;
    } catch {
      return null;
    }
  };
}

/** 設定から Firestore インスタンスを構築する */
function createFirestoreInstance(
  settings: FirestoreSettings | undefined,
  databaseId: string,
): Firestore {
  const config = { ...DEFAULT_SETTINGS, ...settings };
  // デフォルト以外のデータベースは /databases/:databaseId プレフィックス経由でアクセスする
  const basePath =
    databaseId === DEFAULT_DATABASE_ID ? "" : `/databases/${encodeURIComponent(databaseId)}`;
  const transport = new HttpTransport(
    config.host,
    config.port,
    config.ssl,
    basePath,
    settings?.authTokenProvider,
  );
  return {
    type: "firestore",
    _transport: transport,
    _databaseId: databaseId,
    _ignoreUndefinedProperties: settings?.ignoreUndefinedProperties ?? false,
  } as Firestore;
}

export function getFirestore(settings?: FirestoreSettings, databaseId?: string): Firestore;
export function getFirestore(app: unknown, databaseId?: string): Firestore;
export function getFirestore(
  settingsOrApp?: FirestoreSettings | unknown,
  databaseId?: string,
): Firestore {
  const resolvedDatabaseId = databaseId ?? DEFAULT_DATABASE_ID;

  // FirebaseApp が渡された場合: インスタンスをキャッシュし、
  // firebase/auth の ID トークンを自動的に authTokenProvider として配線する
  if (isFirebaseApp(settingsOrApp) && !isFirestoreSettings(settingsOrApp)) {
    let instances = appFirestoreInstances.get(settingsOrApp);
    if (!instances) {
      instances = new Map();
      appFirestoreInstances.set(settingsOrApp, instances);
    }
    let instance = instances.get(resolvedDatabaseId);
    if (!instance) {
      instance = createFirestoreInstance(
        { authTokenProvider: createFirebaseAppTokenProvider(settingsOrApp) },
        resolvedDatabaseId,
      );
      instances.set(resolvedDatabaseId, instance);
    }
    return instance;
  }

  const settings =
    settingsOrApp === undefined || settingsOrApp === null || isFirestoreSettings(settingsOrApp)
      ? (settingsOrApp as FirestoreSettings | undefined)
      : undefined;

  return createFirestoreInstance(settings, resolvedDatabaseId);
}

/**
 * Firebase Auth Emulator 互換の mockUserToken
 *
 * 文字列の場合はそのままトークンとして送信される。
 * オブジェクトの場合は `sub`（または `user_id`）を uid とし、
 * LocalAuthProvider が解釈する `<uid>:<claims JSON>` 形式に変換される。
 */
export type EmulatorMockTokenOptions =
  | string
  | ({ sub?: string; user_id?: string } & Record<string, unknown>);

/** connectFirestoreEmulator のオプション */
export interface ConnectFirestoreEmulatorOptions {
  mockUserToken?: EmulatorMockTokenOptions;
}

/**
 * connectFirestoreEmulator - Firebase互換のエミュレータ接続関数
 *
 * 本家 SDK から移行したコードがそのまま動くための互換シム。
 * `getFirestore(app)` で作成したインスタンスの接続先を local-firestore
 * サーバーのホスト/ポートへ差し替える。
 *
 * 本家と同様、Firestore の使用開始後（リスナー登録後など）に呼び出すとエラーになる。
 */
export function connectFirestoreEmulator(
  firestore: Firestore,
  host: string,
  port: number,
  options?: ConnectFirestoreEmulatorOptions,
): void {
  if (hasConnectionManager(firestore)) {
    throw new FirestoreError(
      "failed-precondition",
      "Firestore has already been started and its settings can no longer be changed. " +
        "connectFirestoreEmulator() must be called before any other Firestore operation.",
    );
  }

  const databaseId = firestore._databaseId ?? DEFAULT_DATABASE_ID;
  const basePath =
    databaseId === DEFAULT_DATABASE_ID ? "" : `/databases/${encodeURIComponent(databaseId)}`;

  let authTokenProvider = firestore._transport.getAuthTokenProvider();
  const mockUserToken = options?.mockUserToken;
  if (mockUserToken !== undefined) {
    const token =
      typeof mockUserToken === "string" ? mockUserToken : buildMockUserToken(mockUserToken);
    authTokenProvider = () => token;
  }

  firestore._transport = new HttpTransport(host, port, false, basePath, authTokenProvider);
  logDebug(`Connected to Firestore emulator at ${host}:${port}`);
}

/** オブジェクト形式の mockUserToken を LocalAuthProvider が解釈できる形式へ変換する */
function buildMockUserToken(
  token: { sub?: string; user_id?: string } & Record<string, unknown>,
): string {
  const uid = token.sub ?? token.user_id;
  if (!uid) {
    throw new FirestoreError(
      "invalid-argument",
      "mockUserToken must contain 'sub' or 'user_id' field",
    );
  }
  return `${uid}:${JSON.stringify(token)}`;
}

/**
 * initializeFirestore - Firebase互換の初期化関数
 *
 * `getFirestore` と同じ機能だが、Firebase SDKの `initializeFirestore` と
 * 同じシグネチャを持つ。`app` パラメータは互換性のために受け取るが無視する。
 */
export function initializeFirestore(_app: unknown, settings: FirestoreSettings): Firestore {
  return getFirestore(settings);
}

/** Firestore インスタンスを終了する */
export function terminate(firestore: Firestore): Promise<void> {
  const manager = getConnectionManager(firestore);
  manager.dispose();
  return Promise.resolve();
}

/**
 * ネットワーク接続を無効化する
 *
 * 無効化中の書き込みはローカルストアの MutationQueue に保持され、ローカルビュー
 * （リスナー・キャッシュ読み取り）へは即時反映される。`enableNetwork()` 呼び出し時に
 * まとめてサーバーへ送信される。
 */
export function disableNetwork(firestore: Firestore): Promise<void> {
  setNetworkEnabled(firestore, false);
  const manager = getConnectionManager(firestore);
  manager.disconnect();
  logDebug("Network disabled");
  return Promise.resolve();
}

/** ネットワーク接続を有効化し、キュー済みの書き込みをフラッシュする */
export async function enableNetwork(firestore: Firestore): Promise<void> {
  setNetworkEnabled(firestore, true);
  const manager = getConnectionManager(firestore);
  manager.connect();
  const store = getLocalStore(firestore);
  logDebug(`Network enabled, flushing ${store.pendingMutationCount} queued write(s)`);
  await store.flush();
}

/**
 * 保留中の書き込みがすべてサーバーで確定（ack または reject）されるまで待機する。
 * 呼び出し時点でキューにある書き込みのみを待つ（本家と同じセマンティクス）。
 */
export function waitForPendingWrites(firestore: Firestore): Promise<void> {
  return getLocalStore(firestore).waitForPendingWrites();
}
