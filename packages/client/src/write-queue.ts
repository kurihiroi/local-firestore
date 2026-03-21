import type { DocumentData, SetOptions } from "@local-firestore/shared";
import type { HttpTransport } from "./transport.js";

/** キューに入れる書き込み操作の種別 */
export type WriteOperationType = "set" | "update" | "delete" | "add";

/** キューに入れる書き込み操作 */
export interface QueuedWrite {
  id: string;
  type: WriteOperationType;
  path: string;
  data?: DocumentData;
  options?: SetOptions;
  timestamp: number;
  retryCount: number;
}

/** 書き込みキューのイベント */
export type WriteQueueEvent = "enqueued" | "flushing" | "flushed" | "error";

/** 書き込みキューのイベントリスナー */
export type WriteQueueListener = (event: WriteQueueEvent, write?: QueuedWrite) => void;

let queueIdCounter = 0;

/**
 * オフライン時の書き込みキュー
 *
 * オフライン中に行われた書き込み操作をキューに保持し、
 * オンライン復帰後に自動的にサーバーに送信する。
 */
export class WriteQueue {
  private queue: QueuedWrite[] = [];
  private flushing = false;
  private listeners = new Set<WriteQueueListener>();

  constructor(private transport: HttpTransport) {}

  /** キューのサイズ */
  get size(): number {
    return this.queue.length;
  }

  /** キューの中身を取得（読み取り専用） */
  get pendingWrites(): ReadonlyArray<QueuedWrite> {
    return this.queue;
  }

  /** イベントリスナーを追加 */
  addListener(listener: WriteQueueListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 書き込み操作をキューに追加 */
  enqueue(
    type: WriteOperationType,
    path: string,
    data?: DocumentData,
    options?: SetOptions,
  ): QueuedWrite {
    const write: QueuedWrite = {
      id: `wq_${++queueIdCounter}_${Date.now()}`,
      type,
      path,
      data,
      options,
      timestamp: Date.now(),
      retryCount: 0,
    };
    this.queue.push(write);
    this.emit("enqueued", write);
    return write;
  }

  /** キュー内の書き込みをすべてサーバーに送信する */
  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    this.emit("flushing");

    while (this.queue.length > 0) {
      const write = this.queue[0];
      try {
        await this.executeWrite(write);
        this.queue.shift();
        this.emit("flushed", write);
      } catch {
        write.retryCount++;
        this.emit("error", write);
        break; // 失敗したら中断して次の flush で再試行
      }
    }

    this.flushing = false;
  }

  /** キューをクリアする */
  clear(): void {
    this.queue = [];
  }

  private async executeWrite(write: QueuedWrite): Promise<void> {
    switch (write.type) {
      case "set":
        await this.transport.put(`/docs/${write.path}`, {
          data: write.data,
          options: write.options,
        });
        break;
      case "update":
        await this.transport.patch(`/docs/${write.path}`, { data: write.data });
        break;
      case "delete":
        await this.transport.delete(`/docs/${write.path}`);
        break;
      case "add":
        await this.transport.post("/docs", {
          collectionPath: write.path,
          data: write.data,
        });
        break;
    }
  }

  private emit(event: WriteQueueEvent, write?: QueuedWrite): void {
    for (const listener of this.listeners) {
      listener(event, write);
    }
  }
}
