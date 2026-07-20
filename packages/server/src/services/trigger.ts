import type { DocumentData, DocumentMetadata } from "@local-firestore/shared";
import type Database from "better-sqlite3";

/** トリガーイベントの種別 */
export type TriggerEventType = "create" | "update" | "delete" | "write";

/** トリガーイベント */
export interface TriggerEvent {
  type: TriggerEventType;
  path: string;
  /** 変更前のデータ（create時はundefined） */
  oldData?: DocumentData;
  /** 変更後のデータ（delete時はundefined） */
  newData?: DocumentData;
  /** 変更前のメタデータ */
  oldDocument?: DocumentMetadata;
  /** 変更後のメタデータ */
  newDocument?: DocumentMetadata;
}

/** トリガーハンドラ関数 */
export type TriggerHandler = (event: TriggerEvent) => void | Promise<void>;

/** 登録されたトリガー */
interface RegisteredTrigger {
  id: string;
  /** コレクションパスのパターン（例: "users", "users/{userId}/posts"） */
  collectionPattern: string;
  eventType: TriggerEventType;
  handler: TriggerHandler;
  /** Webhook 登録時のコールバック URL（Node.js API 登録時は undefined） */
  callbackUrl?: string;
}

/** トリガーの公開情報（一覧取得用） */
export interface TriggerInfo {
  id: string;
  collectionPattern: string;
  eventType: TriggerEventType;
  callbackUrl?: string;
}

/** リトライ設定 */
export interface TriggerRetryOptions {
  /** 最大試行回数（初回を含む）。超過でデッドレターへ。デフォルト 5 */
  maxAttempts?: number;
  /** リトライの初期バックオフ（ミリ秒）。デフォルト 1000 */
  initialBackoffMs?: number;
  /** リトライの最大バックオフ（ミリ秒）。デフォルト 60000 */
  maxBackoffMs?: number;
}

/** キュー上のイベント行 */
interface EventRow {
  id: number;
  triggerId: string;
  callbackUrl: string | null;
  /** TriggerEvent の JSON */
  event: string;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: string;
}

/** デッドレターの公開情報 */
export interface DeadLetterInfo {
  id: number;
  triggerId: string;
  callbackUrl?: string;
  event: TriggerEvent;
  attempts: number;
  lastError?: string;
  createdAt: string;
}

/**
 * イベントキューのストア。
 * SQLite 実装（プロセス再起動を跨いで永続）とメモリ実装（db 未指定時）がある。
 */
interface EventStore {
  insert(row: Omit<EventRow, "id" | "attempts" | "lastError">): void;
  /** 実行時刻が到来した pending イベントを取得する */
  takeDue(now: number, limit: number): EventRow[];
  reschedule(id: number, attempts: number, nextAttemptAt: number, error: string): void;
  markDead(id: number, attempts: number, error: string): void;
  remove(id: number): void;
  /** pending イベントの最も早い実行予定時刻（なければ undefined） */
  earliestPendingAt(): number | undefined;
  listDead(): EventRow[];
  /** デッドレターを pending に戻す。存在しなければ false */
  requeueDead(id: number, now: number): boolean;
  clear(): void;
}

class MemoryEventStore implements EventStore {
  private rows: (EventRow & { status: "pending" | "dead" })[] = [];
  private nextId = 1;

  insert(row: Omit<EventRow, "id" | "attempts" | "lastError">): void {
    this.rows.push({ ...row, id: this.nextId++, attempts: 0, lastError: null, status: "pending" });
  }

  takeDue(now: number, limit: number): EventRow[] {
    return this.rows
      .filter((r) => r.status === "pending" && r.nextAttemptAt <= now)
      .slice(0, limit);
  }

  reschedule(id: number, attempts: number, nextAttemptAt: number, error: string): void {
    const row = this.rows.find((r) => r.id === id);
    if (row) {
      row.attempts = attempts;
      row.nextAttemptAt = nextAttemptAt;
      row.lastError = error;
    }
  }

  markDead(id: number, attempts: number, error: string): void {
    const row = this.rows.find((r) => r.id === id);
    if (row) {
      row.status = "dead";
      row.attempts = attempts;
      row.lastError = error;
    }
  }

  remove(id: number): void {
    this.rows = this.rows.filter((r) => r.id !== id);
  }

  earliestPendingAt(): number | undefined {
    let earliest: number | undefined;
    for (const r of this.rows) {
      if (r.status !== "pending") continue;
      if (earliest === undefined || r.nextAttemptAt < earliest) earliest = r.nextAttemptAt;
    }
    return earliest;
  }

  listDead(): EventRow[] {
    return this.rows.filter((r) => r.status === "dead");
  }

  requeueDead(id: number, now: number): boolean {
    const row = this.rows.find((r) => r.id === id && r.status === "dead");
    if (!row) return false;
    row.status = "pending";
    row.attempts = 0;
    row.nextAttemptAt = now;
    return true;
  }

  clear(): void {
    this.rows = [];
  }
}

interface RawEventRow {
  id: number;
  trigger_id: string;
  callback_url: string | null;
  event: string;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: string;
}

class SqliteEventStore implements EventStore {
  constructor(private db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS trigger_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger_id TEXT NOT NULL,
        callback_url TEXT,
        event TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trigger_events_pending
        ON trigger_events(status, next_attempt_at);
    `);
  }

  insert(row: Omit<EventRow, "id" | "attempts" | "lastError">): void {
    this.db
      .prepare(
        `INSERT INTO trigger_events (trigger_id, callback_url, event, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.triggerId, row.callbackUrl, row.event, row.nextAttemptAt, row.createdAt);
  }

  takeDue(now: number, limit: number): EventRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM trigger_events
         WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY next_attempt_at LIMIT ?`,
      )
      .all(now, limit) as RawEventRow[];
    return rows.map(toEventRow);
  }

  reschedule(id: number, attempts: number, nextAttemptAt: number, error: string): void {
    this.db
      .prepare(
        "UPDATE trigger_events SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?",
      )
      .run(attempts, nextAttemptAt, error, id);
  }

  markDead(id: number, attempts: number, error: string): void {
    this.db
      .prepare(
        "UPDATE trigger_events SET status = 'dead', attempts = ?, last_error = ? WHERE id = ?",
      )
      .run(attempts, error, id);
  }

  remove(id: number): void {
    this.db.prepare("DELETE FROM trigger_events WHERE id = ?").run(id);
  }

  earliestPendingAt(): number | undefined {
    const row = this.db
      .prepare("SELECT MIN(next_attempt_at) AS next FROM trigger_events WHERE status = 'pending'")
      .get() as { next: number | null };
    return row.next ?? undefined;
  }

  listDead(): EventRow[] {
    const rows = this.db
      .prepare("SELECT * FROM trigger_events WHERE status = 'dead' ORDER BY id")
      .all() as RawEventRow[];
    return rows.map(toEventRow);
  }

  requeueDead(id: number, now: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE trigger_events SET status = 'pending', attempts = 0, next_attempt_at = ?
         WHERE id = ? AND status = 'dead'`,
      )
      .run(now, id);
    return result.changes > 0;
  }

  clear(): void {
    this.db.prepare("DELETE FROM trigger_events").run();
  }
}

function toEventRow(row: RawEventRow): EventRow {
  return {
    id: row.id,
    triggerId: row.trigger_id,
    callbackUrl: row.callback_url,
    event: row.event,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

let triggerIdCounter = 0;

/**
 * Cloud Functions トリガーのエミュレーション
 *
 * ドキュメントの create/update/delete/write イベントに応じて
 * 登録されたハンドラを実行する。
 *
 * 配信は at-least-once: イベントは通知時にキュー（db 指定時は SQLite に永続、
 * 未指定時はメモリ）へ登録され、ハンドラ失敗時は指数バックオフでリトライ、
 * 最大試行回数超過でデッドレターに退避される。Webhook 登録（callbackUrl）は
 * SQLite に永続化され、サーバー再起動後も配信が再開される。
 * Node.js API で登録したハンドラ関数は永続化できないため、再起動を跨いだ
 * イベントは配信先ハンドラの再登録がない限りリトライ失敗 → デッドレターになる。
 */
export class TriggerService {
  private triggers: RegisteredTrigger[] = [];
  private store: EventStore;
  private db: Database.Database | null;
  private maxAttempts: number;
  private initialBackoffMs: number;
  private maxBackoffMs: number;
  private pumping = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(db?: Database.Database, options: TriggerRetryOptions = {}) {
    this.db = db ?? null;
    this.store = db ? new SqliteEventStore(db) : new MemoryEventStore();
    this.maxAttempts = options.maxAttempts ?? 5;
    this.initialBackoffMs = options.initialBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;

    if (db) {
      this.loadPersistedWebhooks(db);
      // 前回起動時の未配信イベントを再開する
      this.scheduleNext();
    }
  }

  /** トリガーを登録する */
  register(
    collectionPattern: string,
    eventType: TriggerEventType,
    handler: TriggerHandler,
  ): string {
    const id = `trigger_${++triggerIdCounter}`;
    this.triggers.push({ id, collectionPattern, eventType, handler });
    return id;
  }

  /** onCreate トリガーを登録する */
  onCreate(collectionPattern: string, handler: TriggerHandler): string {
    return this.register(collectionPattern, "create", handler);
  }

  /** onUpdate トリガーを登録する */
  onUpdate(collectionPattern: string, handler: TriggerHandler): string {
    return this.register(collectionPattern, "update", handler);
  }

  /** onDelete トリガーを登録する */
  onDelete(collectionPattern: string, handler: TriggerHandler): string {
    return this.register(collectionPattern, "delete", handler);
  }

  /** onWrite トリガーを登録する（create/update/delete すべて） */
  onWrite(collectionPattern: string, handler: TriggerHandler): string {
    return this.register(collectionPattern, "write", handler);
  }

  /**
   * コールバック URL への Webhook トリガーを登録する
   *
   * イベント発生時に TriggerEvent を JSON として callbackUrl へ POST する。
   * 別プロセスで動作する Cloud Functions エミュレータとの連携用。
   * db 指定時は登録が永続化され、サーバー再起動後も有効。
   */
  registerWebhook(
    collectionPattern: string,
    eventType: TriggerEventType,
    callbackUrl: string,
  ): string {
    const id = `trigger_${++triggerIdCounter}`;
    this.triggers.push({
      id,
      collectionPattern,
      eventType,
      handler: webhookHandler(callbackUrl),
      callbackUrl,
    });
    this.db
      ?.prepare(
        `INSERT INTO trigger_webhooks (id, collection_pattern, event_type, callback_url)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, collectionPattern, eventType, callbackUrl);
    return id;
  }

  /** 登録済みトリガーの一覧を取得する */
  list(): TriggerInfo[] {
    return this.triggers.map(({ id, collectionPattern, eventType, callbackUrl }) => ({
      id,
      collectionPattern,
      eventType,
      callbackUrl,
    }));
  }

  /** トリガーを解除する */
  unregister(triggerId: string): boolean {
    const index = this.triggers.findIndex((t) => t.id === triggerId);
    if (index === -1) return false;
    this.triggers.splice(index, 1);
    this.db?.prepare("DELETE FROM trigger_webhooks WHERE id = ?").run(triggerId);
    return true;
  }

  /** 全トリガーとキューをクリアする */
  clear(): void {
    this.triggers = [];
    this.store.clear();
    this.db?.prepare("DELETE FROM trigger_webhooks").run();
  }

  /** タイマーを解放する（シャットダウン / テスト用） */
  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 登録済みトリガー数 */
  get size(): number {
    return this.triggers.length;
  }

  /** デッドレター（最大試行回数を超過したイベント）の一覧 */
  listDeadLetters(): DeadLetterInfo[] {
    return this.store.listDead().map((row) => ({
      id: row.id,
      triggerId: row.triggerId,
      callbackUrl: row.callbackUrl ?? undefined,
      event: JSON.parse(row.event) as TriggerEvent,
      attempts: row.attempts,
      lastError: row.lastError ?? undefined,
      createdAt: row.createdAt,
    }));
  }

  /** デッドレターのイベントを再キューする */
  retryDeadLetter(id: number): boolean {
    const requeued = this.store.requeueDead(id, Date.now());
    if (requeued) void this.pump();
    return requeued;
  }

  /**
   * ドキュメント変更を通知する。
   *
   * マッチするトリガーごとにイベントをキューへ登録（db 指定時はこの時点で
   * 永続化）し、配信を開始する。返す Promise は即時配信の 1 サイクルが
   * 完了したときに解決する（失敗イベントはバックグラウンドでリトライされる）。
   */
  async notifyChange(
    path: string,
    oldDocument: DocumentMetadata | undefined,
    newDocument: DocumentMetadata | undefined,
  ): Promise<void> {
    const eventType = this.determineEventType(oldDocument, newDocument);
    if (!eventType) return;

    const event: TriggerEvent = {
      type: eventType,
      path,
      oldData: oldDocument?.data,
      newData: newDocument?.data,
      oldDocument,
      newDocument,
    };

    const collectionPath = path.split("/").slice(0, -1).join("/");

    const matchingTriggers = this.triggers.filter((t) => {
      if (t.eventType !== "write" && t.eventType !== eventType) return false;
      return this.matchesPattern(collectionPath, t.collectionPattern);
    });

    if (matchingTriggers.length === 0) return;

    const now = Date.now();
    const eventJson = JSON.stringify(event);
    for (const trigger of matchingTriggers) {
      this.store.insert({
        triggerId: trigger.id,
        callbackUrl: trigger.callbackUrl ?? null,
        event: eventJson,
        nextAttemptAt: now,
        createdAt: new Date(now).toISOString(),
      });
    }

    await this.pump();
  }

  /** 実行時刻が到来したイベントを配信する（多重起動はしない） */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const due = this.store.takeDue(Date.now(), 10);
        if (due.length === 0) break;
        for (const row of due) {
          await this.deliver(row);
        }
      }
    } finally {
      this.pumping = false;
      this.scheduleNext();
    }
  }

  /** 1 イベントを配信し、失敗時はリトライ予約またはデッドレター化する */
  private async deliver(row: EventRow): Promise<void> {
    try {
      const event = JSON.parse(row.event) as TriggerEvent;
      if (row.callbackUrl) {
        await webhookHandler(row.callbackUrl)(event);
      } else {
        const trigger = this.triggers.find((t) => t.id === row.triggerId);
        if (!trigger) {
          throw new Error(
            `Trigger ${row.triggerId} is not registered (handler lost after restart?)`,
          );
        }
        await trigger.handler(event);
      }
      this.store.remove(row.id);
    } catch (err) {
      const attempts = row.attempts + 1;
      const message = err instanceof Error ? err.message : String(err);
      if (attempts >= this.maxAttempts) {
        this.store.markDead(row.id, attempts, message);
        console.error(
          `Trigger event ${row.id} (${row.triggerId}) moved to dead letter after ${attempts} attempts: ${message}`,
        );
      } else {
        const backoff = Math.min(this.initialBackoffMs * 2 ** (attempts - 1), this.maxBackoffMs);
        this.store.reschedule(row.id, attempts, Date.now() + backoff, message);
      }
    }
  }

  /** 次の pending イベントの実行時刻にタイマーを合わせる */
  private scheduleNext(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const next = this.store.earliestPendingAt();
    if (next === undefined) return;
    const delay = Math.max(0, next - Date.now());
    const timer = setTimeout(() => {
      this.timer = null;
      void this.pump();
    }, delay);
    timer.unref?.();
    this.timer = timer;
  }

  /** 永続化された Webhook 登録を復元する */
  private loadPersistedWebhooks(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS trigger_webhooks (
        id TEXT PRIMARY KEY,
        collection_pattern TEXT NOT NULL,
        event_type TEXT NOT NULL,
        callback_url TEXT NOT NULL
      );
    `);
    const rows = db.prepare("SELECT * FROM trigger_webhooks").all() as Array<{
      id: string;
      collection_pattern: string;
      event_type: string;
      callback_url: string;
    }>;
    for (const row of rows) {
      this.triggers.push({
        id: row.id,
        collectionPattern: row.collection_pattern,
        eventType: row.event_type as TriggerEventType,
        handler: webhookHandler(row.callback_url),
        callbackUrl: row.callback_url,
      });
      // ID の衝突を避けるためカウンターを進める
      const suffix = Number(row.id.replace("trigger_", ""));
      if (Number.isInteger(suffix) && suffix > triggerIdCounter) {
        triggerIdCounter = suffix;
      }
    }
  }

  private determineEventType(
    oldDocument: DocumentMetadata | undefined,
    newDocument: DocumentMetadata | undefined,
  ): TriggerEventType | null {
    if (!oldDocument && newDocument) return "create";
    if (oldDocument && newDocument) return "update";
    if (oldDocument && !newDocument) return "delete";
    return null;
  }

  private matchesPattern(collectionPath: string, pattern: string): boolean {
    // ワイルドカードパターンのマッチング
    // 例: "users/{userId}/posts" は "users/alice/posts" にマッチ
    const patternParts = pattern.split("/");
    const pathParts = collectionPath.split("/");

    if (patternParts.length !== pathParts.length) return false;

    return patternParts.every((part, i) => {
      if (part.startsWith("{") && part.endsWith("}")) return true;
      return part === pathParts[i];
    });
  }
}

/** callbackUrl へ TriggerEvent を POST するハンドラを作る */
function webhookHandler(callbackUrl: string): TriggerHandler {
  return async (event) => {
    const res = await fetch(callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    if (!res.ok) {
      throw new Error(`Webhook callback failed: ${res.status} ${callbackUrl}`);
    }
  };
}
