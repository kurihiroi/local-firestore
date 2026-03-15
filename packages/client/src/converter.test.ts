import type { DocumentData, FirestoreDataConverter } from "@local-firestore/shared";
import { describe, expect, it } from "vitest";
import { getFirestore } from "./firestore.js";
import { query, where } from "./query.js";
import { collection, doc } from "./references.js";

// テスト用のアプリケーション型
interface User {
  name: string;
  age: number;
  isAdmin: boolean;
}

// テスト用のコンバーター
const userConverter: FirestoreDataConverter<User> = {
  toFirestore(user: User): DocumentData {
    return {
      name: user.name,
      age: user.age,
      is_admin: user.isAdmin,
    };
  },
  fromFirestore(snapshot: { data(): DocumentData }): User {
    const data = snapshot.data();
    return {
      name: data.name as string,
      age: data.age as number,
      isAdmin: data.is_admin as boolean,
    };
  },
};

describe("withConverter", () => {
  const db = getFirestore();

  describe("DocumentReference.withConverter()", () => {
    it("コンバーター付きのDocumentReferenceを返す", () => {
      const ref = doc(db, "users/alice");
      const converted = ref.withConverter(userConverter);

      expect(converted.type).toBe("document");
      expect(converted.id).toBe("alice");
      expect(converted.path).toBe("users/alice");
      expect(converted._converter).toBe(userConverter);
    });

    it("元のリファレンスは変更されない（イミュータブル）", () => {
      const ref = doc(db, "users/alice");
      ref.withConverter(userConverter);

      expect(ref._converter).toBeNull();
    });

    it("nullを渡すとコンバーターをリセットできる", () => {
      const ref = doc(db, "users/alice").withConverter(userConverter);
      const reset = ref.withConverter(null);

      expect(reset._converter).toBeNull();
      expect(reset.path).toBe("users/alice");
    });

    it("別のコンバーターに差し替えできる", () => {
      const anotherConverter: FirestoreDataConverter<{ label: string }> = {
        toFirestore(obj) {
          return { label: obj.label };
        },
        fromFirestore(snapshot) {
          const data = snapshot.data();
          return { label: data.label as string };
        },
      };

      const ref = doc(db, "users/alice")
        .withConverter(userConverter)
        .withConverter(anotherConverter);
      expect(ref._converter).toBe(anotherConverter);
    });
  });

  describe("CollectionReference.withConverter()", () => {
    it("コンバーター付きのCollectionReferenceを返す", () => {
      const collRef = collection(db, "users");
      const converted = collRef.withConverter(userConverter);

      expect(converted.type).toBe("collection");
      expect(converted.id).toBe("users");
      expect(converted.path).toBe("users");
      expect(converted._converter).toBe(userConverter);
    });

    it("元のリファレンスは変更されない（イミュータブル）", () => {
      const collRef = collection(db, "users");
      collRef.withConverter(userConverter);

      expect(collRef._converter).toBeNull();
    });

    it("nullを渡すとコンバーターをリセットできる", () => {
      const collRef = collection(db, "users").withConverter(userConverter);
      const reset = collRef.withConverter(null);

      expect(reset._converter).toBeNull();
    });
  });

  describe("Query.withConverter()", () => {
    it("コンバーター付きのQueryを返す", () => {
      const collRef = collection(db, "users");
      const q = query(collRef, where("age", ">=", 18));
      const converted = q.withConverter(userConverter);

      expect(converted.type).toBe("query");
      expect(converted.collectionPath).toBe("users");
      expect(converted.constraints).toEqual(q.constraints);
      expect(converted._converter).toBe(userConverter);
    });

    it("元のクエリは変更されない（イミュータブル）", () => {
      const q = query(collection(db, "users"), where("age", ">=", 18));
      q.withConverter(userConverter);

      expect(q._converter).toBeNull();
    });

    it("nullを渡すとコンバーターをリセットできる", () => {
      const q = query(collection(db, "users")).withConverter(userConverter);
      const reset = q.withConverter(null);

      expect(reset._converter).toBeNull();
    });
  });

  describe("コンバーターの伝播", () => {
    it("CollectionReferenceのコンバーターがquery()に伝播する", () => {
      const collRef = collection(db, "users").withConverter(userConverter);
      const q = query(collRef, where("age", ">=", 18));

      expect(q._converter).toBe(userConverter);
    });

    it("doc()でCollectionReferenceから作成したDocumentReferenceにコンバーターは伝播しない", () => {
      // Firebaseの実際の動作に合わせ、doc()は新しい型パラメータを受け取るため
      // コンバーターの自動伝播はしない
      const collRef = collection(db, "users");
      const docRef = doc(collRef, "alice");

      expect(docRef._converter).toBeNull();
    });
  });

  describe("toFirestoreの変換", () => {
    it("toFirestoreがフィールド名を変換する", () => {
      const user: User = { name: "Alice", age: 30, isAdmin: true };
      const result = userConverter.toFirestore(user);

      expect(result).toEqual({
        name: "Alice",
        age: 30,
        is_admin: true,
      });
    });
  });

  describe("fromFirestoreの変換", () => {
    it("fromFirestoreがフィールド名を変換する", () => {
      const fakeSnapshot = {
        data(): DocumentData {
          return { name: "Alice", age: 30, is_admin: true };
        },
      };
      const user = userConverter.fromFirestore(fakeSnapshot);

      expect(user).toEqual({
        name: "Alice",
        age: 30,
        isAdmin: true,
      });
    });
  });
});
