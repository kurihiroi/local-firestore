export type { AppOptions } from "./app.js";
export { createApp } from "./app.js";
export type { LogEntry, LogLevel, LogOutput } from "./middleware/logger.js";
export { ConsoleLogOutput, JsonLogOutput, Logger, requestLogger } from "./middleware/logger.js";
export type { ServerMetrics } from "./middleware/metrics.js";
export { MetricsCollector, metricsMiddleware } from "./middleware/metrics.js";
export type { MigrateOptions, MigrationReport } from "./migration/migrate.js";
export { migrateDatabase } from "./migration/migrate.js";
export type { NormalizeStats } from "./migration/normalize.js";
export { normalizeLegacyDocumentData } from "./migration/normalize.js";
export type {
  RegisterTriggerRequest,
  RegisterTriggerResponse,
} from "./routes/triggers.js";
export { createTriggerRoutes } from "./routes/triggers.js";
export type { AuthProvider } from "./security/auth-provider.js";
export { LocalAuthProvider } from "./security/auth-provider.js";
export { FirebaseAuthProvider } from "./security/firebase-auth-provider.js";
export type {
  AuthContext,
  CollectionRule,
  CollectionRules,
  Operation,
  RuleContext,
  RuleEvaluationResult,
  SecurityRules,
} from "./security/rules-engine.js";
export {
  createAuthRequiredRules,
  createOpenRules,
  SecurityRulesEngine,
} from "./security/rules-engine.js";
export { securityRulesMiddleware } from "./security/rules-middleware.js";
export { looksLikeRulesText, parseRulesText } from "./security/rules-text-parser.js";
export type { DatabaseInstance } from "./services/database-manager.js";
export {
  DatabaseManager,
  DEFAULT_DATABASE_ID,
  isValidDatabaseId,
  resolveDatabasePath,
} from "./services/database-manager.js";
export { DocumentNotFoundError, DocumentService } from "./services/document.js";
export type {
  CompositeIndex,
  IndexConfiguration,
  IndexField,
  IndexValidationMode,
  IndexValidationResult,
} from "./services/index-manager.js";
export { IndexManager } from "./services/index-manager.js";
export { ListenerManager } from "./services/listener-manager.js";
export { QueryService } from "./services/query.js";
export type { TransactionServiceOptions } from "./services/transaction.js";
export {
  TransactionConflictError,
  TransactionExpiredError,
  TransactionNotFoundError,
  TransactionService,
} from "./services/transaction.js";
export type {
  TriggerEvent,
  TriggerEventType,
  TriggerHandler,
  TriggerInfo,
} from "./services/trigger.js";
export { TriggerService } from "./services/trigger.js";
export type { TtlCleanupResult, TtlPolicy } from "./services/ttl.js";
export { matchesCollectionPattern, TtlService } from "./services/ttl.js";
export { DocumentRepository } from "./storage/repository.js";
export type { CreateDatabaseOptions } from "./storage/sqlite.js";
export { createDatabase, DatabaseOpenError } from "./storage/sqlite.js";
export type { TlsOptions } from "./tls.js";
export { createTlsServer, getTlsOptionsFromEnv, loadTlsCertificates } from "./tls.js";
export type { DatabaseListenerDeps, WebSocketDeps } from "./websocket.js";
export { attachWebSocket } from "./websocket.js";
