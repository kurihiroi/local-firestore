import { describe, expect, it } from "vitest";
import * as clientExports from "./index.js";

describe("index.ts exports", () => {
  it("Aggregate関連のエクスポートが存在する", () => {
    expect(clientExports.AggregateField).toBeDefined();
    expect(clientExports.AggregateQuerySnapshot).toBeDefined();
    expect(clientExports.count).toBeDefined();
    expect(clientExports.sum).toBeDefined();
    expect(clientExports.average).toBeDefined();
    expect(clientExports.getAggregateFromServer).toBeDefined();
    expect(clientExports.getCountFromServer).toBeDefined();
  });

  it("Batch & Transaction関連のエクスポートが存在する", () => {
    expect(clientExports.WriteBatch).toBeDefined();
    expect(clientExports.writeBatch).toBeDefined();
    expect(clientExports.runTransaction).toBeDefined();
    expect(clientExports.Transaction).toBeDefined();
  });

  it("データ型のエクスポートが存在する", () => {
    expect(clientExports.Bytes).toBeDefined();
    expect(clientExports.GeoPoint).toBeDefined();
    expect(clientExports.VectorValue).toBeDefined();
    expect(clientExports.vector).toBeDefined();
  });

  it("比較関数のエクスポートが存在する", () => {
    expect(clientExports.queryEqual).toBeDefined();
    expect(clientExports.refEqual).toBeDefined();
    expect(clientExports.snapshotEqual).toBeDefined();
  });

  it("接続管理のエクスポートが存在する", () => {
    expect(clientExports.ConnectionManager).toBeDefined();
    expect(clientExports.getConnectionManager).toBeDefined();
  });

  it("CRUD操作のエクスポートが存在する", () => {
    expect(clientExports.addDoc).toBeDefined();
    expect(clientExports.deleteDoc).toBeDefined();
    expect(clientExports.getDoc).toBeDefined();
    expect(clientExports.setDoc).toBeDefined();
    expect(clientExports.updateDoc).toBeDefined();
  });

  it("FieldValue関連のエクスポートが存在する", () => {
    expect(clientExports.arrayRemove).toBeDefined();
    expect(clientExports.arrayUnion).toBeDefined();
    expect(clientExports.deleteField).toBeDefined();
    expect(clientExports.increment).toBeDefined();
    expect(clientExports.serverTimestamp).toBeDefined();
  });

  it("Firestore初期化関連のエクスポートが存在する", () => {
    expect(clientExports.getFirestore).toBeDefined();
    expect(clientExports.initializeFirestore).toBeDefined();
    expect(clientExports.terminate).toBeDefined();
    expect(clientExports.disableNetwork).toBeDefined();
    expect(clientExports.enableNetwork).toBeDefined();
    expect(clientExports.setLogLevel).toBeDefined();
    expect(clientExports.waitForPendingWrites).toBeDefined();
  });

  it("リスナー関連のエクスポートが存在する", () => {
    expect(clientExports.onSnapshot).toBeDefined();
    expect(clientExports.onSnapshotsInSync).toBeDefined();
  });

  it("クエリ関連のエクスポートが存在する", () => {
    expect(clientExports.where).toBeDefined();
    expect(clientExports.orderBy).toBeDefined();
    expect(clientExports.limit).toBeDefined();
    expect(clientExports.limitToLast).toBeDefined();
    expect(clientExports.startAt).toBeDefined();
    expect(clientExports.startAfter).toBeDefined();
    expect(clientExports.endAt).toBeDefined();
    expect(clientExports.endBefore).toBeDefined();
    expect(clientExports.query).toBeDefined();
    expect(clientExports.getDocs).toBeDefined();
    expect(clientExports.collectionGroup).toBeDefined();
    expect(clientExports.and).toBeDefined();
    expect(clientExports.or).toBeDefined();
    expect(clientExports.documentId).toBeDefined();
  });

  it("リファレンス関連のエクスポートが存在する", () => {
    expect(clientExports.collection).toBeDefined();
    expect(clientExports.doc).toBeDefined();
  });

  it("スナップショット関連のエクスポートが存在する", () => {
    expect(clientExports.QueryDocumentSnapshot).toBeDefined();
    expect(clientExports.QuerySnapshot).toBeDefined();
    expect(clientExports.SnapshotCache).toBeDefined();
  });

  it("Transport & Error関連のエクスポートが存在する", () => {
    expect(clientExports.FirestoreError).toBeDefined();
  });

  it("型クラスのエクスポートが存在する", () => {
    expect(clientExports.DocumentSnapshot).toBeDefined();
    expect(clientExports.FieldPath).toBeDefined();
    expect(clientExports.SnapshotMetadata).toBeDefined();
    expect(clientExports.Timestamp).toBeDefined();
  });

  it("WriteQueue関連のエクスポートが存在する", () => {
    expect(clientExports.WriteQueue).toBeDefined();
  });
});
