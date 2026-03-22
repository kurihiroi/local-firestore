import type { DocumentData, DocumentMetadata } from "@local-firestore/shared";

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
}

let triggerIdCounter = 0;

/**
 * Cloud Functions トリガーのエミュレーション
 *
 * ドキュメントの create/update/delete/write イベントに応じて
 * 登録されたハンドラを実行する。
 */
export class TriggerService {
  private triggers: RegisteredTrigger[] = [];

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

  /** トリガーを解除する */
  unregister(triggerId: string): boolean {
    const index = this.triggers.findIndex((t) => t.id === triggerId);
    if (index === -1) return false;
    this.triggers.splice(index, 1);
    return true;
  }

  /** 全トリガーをクリアする */
  clear(): void {
    this.triggers = [];
  }

  /** 登録済みトリガー数 */
  get size(): number {
    return this.triggers.length;
  }

  /**
   * ドキュメント変更を通知し、マッチするトリガーを実行する
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

    for (const trigger of matchingTriggers) {
      try {
        await trigger.handler(event);
      } catch (err) {
        console.error(`Trigger ${trigger.id} failed:`, err);
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
