import { describe, expect, it } from "vitest";
import { getFirestore } from "./firestore.js";
import { collection, doc } from "./references.js";
import { FirestoreError } from "./transport.js";

describe("doc()", () => {
  const db = getFirestore();

  it("Firestoreからドキュメントリファレンスを作成できる", () => {
    const ref = doc(db, "users/alice");
    expect(ref.type).toBe("document");
    expect(ref.id).toBe("alice");
    expect(ref.path).toBe("users/alice");
    expect(ref.parent.path).toBe("users");
  });

  it("複数セグメントでパスを指定できる", () => {
    const ref = doc(db, "users", "alice");
    expect(ref.path).toBe("users/alice");
    expect(ref.id).toBe("alice");
  });

  it("サブコレクションのドキュメントリファレンスを作成できる", () => {
    const ref = doc(db, "users/alice/posts/post1");
    expect(ref.id).toBe("post1");
    expect(ref.path).toBe("users/alice/posts/post1");
    expect(ref.parent.path).toBe("users/alice/posts");
  });

  it("CollectionReferenceからドキュメントリファレンスを作成できる", () => {
    const collRef = collection(db, "users");
    const ref = doc(collRef, "alice");
    expect(ref.path).toBe("users/alice");
    expect(ref.id).toBe("alice");
    expect(ref.parent).toBe(collRef);
  });

  it("不正なパス（奇数セグメント）でエラーを投げる", () => {
    expect(() => doc(db, "users")).toThrow("Invalid document path");
  });
});

describe("collection()", () => {
  const db = getFirestore();

  it("Firestoreからコレクションリファレンスを作成できる", () => {
    const ref = collection(db, "users");
    expect(ref.type).toBe("collection");
    expect(ref.id).toBe("users");
    expect(ref.path).toBe("users");
    expect(ref.parent).toBeNull();
  });

  it("DocumentReferenceからサブコレクションを作成できる", () => {
    const docRef = doc(db, "users/alice");
    const ref = collection(docRef, "posts");
    expect(ref.path).toBe("users/alice/posts");
    expect(ref.id).toBe("posts");
    expect(ref.parent).toBe(docRef);
  });

  it("不正なパス（偶数セグメント）でエラーを投げる", () => {
    expect(() => collection(db, "users/alice")).toThrow("Invalid collection path");
  });
});

describe("firestore / converter 公開プロパティ (2-4)", () => {
  const db = getFirestore();

  it("DocumentReference.firestore が Firestore インスタンスを返す", () => {
    const ref = doc(db, "users/alice");
    expect(ref.firestore).toBe(db);
    expect(ref.firestore).toBe(ref._firestore);
  });

  it("CollectionReference.firestore が Firestore インスタンスを返す", () => {
    const ref = collection(db, "users");
    expect(ref.firestore).toBe(db);
    expect(ref.firestore).toBe(ref._firestore);
  });

  it("converter は未設定時 null、withConverter 後は設定したコンバーターを返す", () => {
    const ref = doc(db, "users/alice");
    expect(ref.converter).toBeNull();

    const converter = {
      toFirestore: (value: { name: string }) => value,
      fromFirestore: (snapshot: { data(): Record<string, unknown> }) =>
        snapshot.data() as { name: string },
    };
    const converted = ref.withConverter(converter);
    expect(converted.converter).toBe(converter);
    expect(converted.converter).toBe(converted._converter);

    // 元のリファレンスは変更されない
    expect(ref.converter).toBeNull();
  });
});

describe("ID / パスの内容バリデーション（本家準拠）", () => {
  const db = getFirestore();

  it("予約名（__.*__）の ID は invalid-argument", () => {
    expect(() => doc(db, "users/__alice__")).toThrow(FirestoreError);
    expect(() => collection(db, "__users__")).toThrow(FirestoreError);
    try {
      doc(db, "users", "__id__");
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as FirestoreError).code).toBe("invalid-argument");
    }
  });

  it('単体の "." / ".." の ID は invalid-argument', () => {
    expect(() => doc(db, "users/.")).toThrow(FirestoreError);
    expect(() => doc(db, "users/..")).toThrow(FirestoreError);
    // ドットを含むだけの ID は許可される
    expect(() => doc(db, "users/a.b")).not.toThrow();
  });

  it("空セグメントを含むパスは invalid-argument", () => {
    expect(() => doc(db, "users//posts/p1")).toThrow(FirestoreError);
    expect(() => collection(db, "users/alice/")).toThrow(FirestoreError);
  });

  it("1500 バイト超の ID は invalid-argument", () => {
    expect(() => doc(db, "users", "a".repeat(1500))).not.toThrow();
    expect(() => doc(db, "users", "a".repeat(1501))).toThrow(FirestoreError);
  });

  it("CollectionReference 起点の doc() でも検証される", () => {
    const users = collection(db, "users");
    expect(() => doc(users, "__bad__")).toThrow(FirestoreError);
    // セグメント数の偶奇も検証される（doc(collRef, "a/b") は 3 セグメントで不正）
    expect(() => doc(users, "a/b")).toThrow(FirestoreError);
    expect(() => doc(users, "a/b/c")).not.toThrow();
  });
});
