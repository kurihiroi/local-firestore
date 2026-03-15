import { describe, expect, it } from "vitest";
import { getFirestore } from "./firestore.js";
import { collection, doc } from "./references.js";

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
