import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import type { LogLevel } from "./middleware/logger.js";
import { JsonLogOutput, Logger } from "./middleware/logger.js";
import type { AuthProvider } from "./security/auth-provider.js";
import { LocalAuthProvider } from "./security/auth-provider.js";
import type { SecurityRules } from "./security/rules-engine.js";
import { SecurityRulesEngine } from "./security/rules-engine.js";
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
import { createDatabase } from "./storage/sqlite.js";
import { createTlsServer, getTlsOptionsFromEnv } from "./tls.js";
import { attachWebSocket } from "./websocket.js";

async function createAuthProvider(logger: Logger): Promise<AuthProvider> {
  if (process.env.AUTH_PROVIDER === "firebase") {
    const { initializeApp } = await import("firebase-admin/app");
    const { getAuth } = await import("firebase-admin/auth");
    const { FirebaseAuthProvider } = await import("./security/firebase-auth-provider.js");
    const firebaseApp = initializeApp();
    logger.info("Using Firebase Auth provider");
    return new FirebaseAuthProvider(getAuth(firebaseApp));
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
    rules = JSON.parse(readFileSync(rulesPath, "utf-8")) as SecurityRules;
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

  const db = createDatabase(dbPath);
  const repo = new DocumentRepository(db);
  const documentService = new DocumentService(repo);
  const queryService = new QueryService(db);
  const listenerManager = new ListenerManager(queryService);

  const authProvider = await createAuthProvider(logger);

  // セキュリティルール（RULES_PATH 指定時のみ有効）
  const securityRules = createSecurityRulesEngine(logger, documentService);

  // Cloud Functions トリガー（POST /triggers で Webhook 登録可能）
  const triggerService = new TriggerService();

  // 複合インデックスのバリデーション（INDEXES_PATH 指定時のみ有効）
  const indexManager = createIndexManager(logger);

  // マルチデータベース対応（/databases/:databaseId/* で独立した SQLite ファイルを使用）
  const databaseManager = new DatabaseManager(dbPath);

  const app = createApp(db, listenerManager, {
    logger,
    authProvider,
    securityRules,
    triggerService,
    indexManager,
    databaseManager,
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

  attachWebSocket(server, {
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
  });
}

main();
