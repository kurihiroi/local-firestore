import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import type { LogLevel } from "./middleware/logger.js";
import { JsonLogOutput, Logger } from "./middleware/logger.js";
import { migrateDatabase } from "./migration/migrate.js";
import type { AuthProvider } from "./security/auth-provider.js";
import { LocalAuthProvider } from "./security/auth-provider.js";
import type { SecurityRules } from "./security/rules-engine.js";
import { SecurityRulesEngine } from "./security/rules-engine.js";
import { looksLikeRulesText, parseRulesText } from "./security/rules-text-parser.js";
import { DatabaseManager } from "./services/database-manager.js";
import { DocumentService } from "./services/document.js";
import type { IndexValidationMode } from "./services/index-manager.js";
import { IndexManager } from "./services/index-manager.js";
import { ListenerManager } from "./services/listener-manager.js";
import { QueryService } from "./services/query.js";
import { TriggerService } from "./services/trigger.js";
import type { TtlPolicy } from "./services/ttl.js";
import { matchesCollectionPattern, TtlService } from "./services/ttl.js";
import { DocumentRepository } from "./storage/repository.js";
import { createDatabase, DatabaseOpenError, parseSynchronousMode } from "./storage/sqlite.js";
import { createTlsServer, getTlsOptionsFromEnv } from "./tls.js";
import { acquireProcessLock, ProcessLockError } from "./utils/process-lock.js";
import { attachWebSocket } from "./websocket.js";

async function createAuthProvider(logger: Logger): Promise<AuthProvider> {
  if (process.env.AUTH_PROVIDER === "firebase") {
    const { initializeApp } = await import("firebase-admin/app");
    const { getAuth } = await import("firebase-admin/auth");
    const { FirebaseAuthProvider } = await import("./security/firebase-auth-provider.js");
    const firebaseApp = initializeApp();
    logger.info("Using Firebase Auth provider");
    // 検証失敗（≠ トークン無し）は静かに匿名へ落ちるため、必ずログで可視化する
    return new FirebaseAuthProvider(getAuth(firebaseApp), {
      onVerificationFailure: (message) => logger.warn(message),
    });
  }
  logger.info("Using Local Auth provider");
  return new LocalAuthProvider();
}

/**
 * RULES_PATH で指定された JSON ファイルからセキュリティルールを読み込む。
 * 未指定時は undefined（ルール未適用 = 全許可）。
 */
function createSecurityRulesEngine(
  logger: Logger,
  documentService: DocumentService,
): SecurityRulesEngine | undefined {
  const rulesPath = process.env.RULES_PATH;
  if (!rulesPath) return undefined;

  let rules: SecurityRules;
  try {
    const content = readFileSync(rulesPath, "utf-8");
    // 本家 firestore.rules テキスト形式と独自 JSON 形式の両方を受け付ける
    if (looksLikeRulesText(content)) {
      rules = parseRulesText(content);
      logger.info("Security rules loaded from firestore.rules text format", { rulesPath });
    } else {
      rules = JSON.parse(content) as SecurityRules;
    }
  } catch (err) {
    throw new Error(`Failed to load security rules from ${rulesPath}: ${String(err)}`);
  }

  const engine = new SecurityRulesEngine(rules, {
    getDocument: (path) => documentService.getDocument(path)?.data ?? null,
  });
  logger.info("Security rules enabled", { rulesPath });
  return engine;
}

function createIndexManager(logger: Logger): IndexManager | undefined {
  const indexesPath = process.env.INDEXES_PATH;
  if (!indexesPath) return undefined;

  const mode = (process.env.INDEX_VALIDATION_MODE || "warn") as IndexValidationMode;
  const indexManager = new IndexManager(mode);
  indexManager.loadConfigurationFromFile(indexesPath);
  logger.info("Index validation enabled", { indexesPath, mode, indexes: indexManager.size });
  return indexManager;
}

function startTtlService(
  logger: Logger,
  repo: DocumentRepository,
  documentService: DocumentService,
  listenerManager: ListenerManager,
  triggerService: TriggerService,
): TtlService | undefined {
  const policiesEnv = process.env.TTL_POLICIES;
  if (!policiesEnv) return undefined;

  let policies: TtlPolicy[];
  try {
    const parsed: unknown = JSON.parse(policiesEnv);
    if (!Array.isArray(parsed)) {
      throw new Error("TTL_POLICIES must be a JSON array");
    }
    policies = parsed as TtlPolicy[];
  } catch (err) {
    throw new Error(`Failed to parse TTL_POLICIES: ${String(err)}`);
  }

  const ttlService = new TtlService(
    documentService,
    (collectionPath) =>
      collectionPath.includes("{")
        ? repo.listAll().filter((d) => matchesCollectionPattern(d.collectionPath, collectionPath))
        : repo.listCollection(collectionPath),
    (path, oldDocument) => {
      // 削除をリスナーとトリガーへ通知する
      listenerManager.notifyChange(path, (p) => documentService.getDocument(p));
      triggerService.notifyChange(path, oldDocument, undefined).catch((err) => {
        logger.error("TTL trigger execution error", { path, error: String(err) });
      });
    },
  );
  for (const policy of policies) {
    ttlService.addPolicy(policy);
  }

  const intervalMs = Number(process.env.TTL_INTERVAL_MS) || 60_000;
  ttlService.start(intervalMs);
  logger.info("TTL service started", { policies: ttlService.policyCount, intervalMs });
  return ttlService;
}

/** 非負整数の環境変数をパースする（未指定は undefined、不正値はエラー） */
function envNonNegativeInt(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid ${name}: "${value}". Must be a non-negative integer.`);
  }
  return n;
}

/**
 * migrate サブコマンド: SQLite ファイル内の旧形式データを現行形式へ変換する。
 *
 * 使用方法: `local-firestore migrate [--dry-run]`（DB_PATH で対象ファイルを指定）
 */
function runMigrate(args: string[]): void {
  const dbPath = process.env.DB_PATH || "local-firestore.db";
  const dryRun = args.includes("--dry-run");

  const db = createDatabase(dbPath, {
    encryptionKey: process.env.DB_ENCRYPTION_KEY,
    synchronous: parseSynchronousMode(process.env.DB_SYNCHRONOUS),
  });
  const report = migrateDatabase(db, { dryRun });
  db.close();

  console.log(JSON.stringify({ dbPath, dryRun, ...report }, null, 2));
  if (report.legacyDeleteMarkers.length > 0) {
    console.error(
      `WARNING: ${report.legacyDeleteMarkers.length} field(s) still contain the legacy ` +
        'delete marker string "$$__DELETE__$$". These are reported only (not modified) — ' +
        "review and fix them manually if they are sentinel residue.",
    );
  }
}

async function main() {
  const port = Number(process.env.PORT) || 8080;
  const dbPath = process.env.DB_PATH || "local-firestore.db";
  const logLevel = (process.env.LOG_LEVEL || "info") as LogLevel;
  const logFormat = process.env.LOG_FORMAT || "text";
  const tlsOptions = getTlsOptionsFromEnv();

  const logger = new Logger({
    level: logLevel,
    output: logFormat === "json" ? new JsonLogOutput() : undefined,
  });

  // graceful shutdown: 登録された後処理を LIFO で実行する
  // （派生 DB の close / トリガータイマー解放 / プロセスロック解放）
  const cleanupTasks: Array<() => void> = [];
  let cleanedUp = false;
  const runCleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    while (cleanupTasks.length > 0) {
      try {
        cleanupTasks.pop()?.();
      } catch (err) {
        logger.error(`Cleanup task failed: ${String(err)}`);
      }
    }
  };
  process.on("exit", runCleanup);
  process.on("SIGINT", () => {
    runCleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    runCleanup();
    process.exit(143);
  });

  // 多重起動ガード: 同一 SQLite ファイルへの複数プロセス起動は
  // リアルタイム通知・トランザクション整合性を壊すため起動を拒否する
  // （1 プロセス = 1 SQLite ファイル。stale ロックは自動回収）
  try {
    const lock = acquireProcessLock(dbPath);
    if (lock) {
      cleanupTasks.push(() => lock.release());
    }
  } catch (err) {
    if (err instanceof ProcessLockError) {
      logger.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  // at-rest 暗号化（DB_ENCRYPTION_KEY 指定時のみ有効）
  const encryptionKey = process.env.DB_ENCRYPTION_KEY;
  if (encryptionKey) {
    logger.info("At-rest encryption enabled (DB_ENCRYPTION_KEY)");
  }

  // 耐久性設定（DB_SYNCHRONOUS=OFF|NORMAL|FULL|EXTRA。デフォルト NORMAL）
  const synchronous = parseSynchronousMode(process.env.DB_SYNCHRONOUS);
  if (synchronous && synchronous !== "NORMAL") {
    logger.info("SQLite synchronous mode overridden", { synchronous });
  }

  let db: ReturnType<typeof createDatabase>;
  try {
    db = createDatabase(dbPath, { encryptionKey, synchronous });
  } catch (err) {
    if (err instanceof DatabaseOpenError) {
      logger.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  const repo = new DocumentRepository(db);
  const documentService = new DocumentService(repo);
  const queryService = new QueryService(db);

  // 過負荷防御の設定（WS_* / MAX_REQUEST_BODY_BYTES。未指定はデフォルト値）
  const listenerOptions = { maxBufferedBytes: envNonNegativeInt("WS_MAX_BUFFERED_BYTES") };
  const listenerManager = new ListenerManager(queryService, listenerOptions);

  const authProvider = await createAuthProvider(logger);

  // セキュリティルール（RULES_PATH 指定時のみ有効）
  const securityRules = createSecurityRulesEngine(logger, documentService);

  // Cloud Functions トリガー（POST /triggers で Webhook 登録可能。
  // イベントは SQLite 永続キューで at-least-once 配信される）
  const triggerService = new TriggerService(db);

  // 複合インデックスのバリデーション（INDEXES_PATH 指定時のみ有効）
  const indexManager = createIndexManager(logger);

  // マルチデータベース対応（/databases/:databaseId/* で独立した SQLite ファイルを使用。
  // 暗号化キーは全データベースで共通）
  const databaseManager = new DatabaseManager(
    dbPath,
    { encryptionKey, synchronous },
    listenerOptions,
  );
  // シャットダウン時にメイン DB / 派生 DB を graceful close する
  // （WAL の反映・派生 DB ロックの解放。LIFO なのでロック解放より先に実行される）
  cleanupTasks.push(() => databaseManager.closeAll());
  cleanupTasks.push(() => triggerService.dispose());

  const app = createApp(db, listenerManager, {
    logger,
    authProvider,
    securityRules,
    triggerService,
    indexManager,
    databaseManager,
    maxRequestBodyBytes: envNonNegativeInt("MAX_REQUEST_BODY_BYTES"),
  });

  // TTL による期限切れドキュメントの自動削除（TTL_POLICIES 指定時のみ有効）
  startTtlService(logger, repo, documentService, listenerManager, triggerService);

  logger.info("Local Firestore server starting", { port, dbPath, logLevel, tls: !!tlsOptions });

  let server: Server;

  if (tlsOptions) {
    server = createTlsServer(app, tlsOptions, port, () => {
      logger.info(`Server is running at https://localhost:${port}`);
    });
  } else {
    server = serve({ fetch: app.fetch, port }, () => {
      logger.info(`Server is running at http://localhost:${port}`);
    }) as Server;
  }

  attachWebSocket(
    server,
    {
      listenerManager,
      getDocument: (path) => documentService.getDocument(path),
      securityRules,
      authProvider,
      resolveDatabase: (databaseId) => {
        const instance = databaseManager.get(databaseId);
        return {
          listenerManager: instance.listenerManager,
          getDocument: (path) => instance.documentService.getDocument(path),
        };
      },
    },
    {
      maxConnections: envNonNegativeInt("WS_MAX_CONNECTIONS"),
      maxPayloadBytes: envNonNegativeInt("WS_MAX_PAYLOAD_BYTES"),
      heartbeatIntervalMs: envNonNegativeInt("WS_HEARTBEAT_INTERVAL_MS"),
    },
  );
}

const subcommand = process.argv[2];
if (subcommand === "migrate") {
  runMigrate(process.argv.slice(3));
} else {
  main();
}
