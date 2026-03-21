import {
  collection,
  collectionGroup,
  doc,
  getDocs,
  type QueryDocumentSnapshot,
  query,
  setDoc,
  where,
} from "@local-firestore/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestContext } from "./helpers.js";

describe("E2E: Collection group queries", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();

    // Create subcollections named "comments" under different parent documents
    const users = collection(ctx.firestore, "cg-users");

    await setDoc(doc(users, "u1"), { name: "Alice" });
    const u1Comments = collection(ctx.firestore, "cg-users/u1/comments");
    await setDoc(doc(u1Comments, "c1"), { text: "Hello", rating: 5 });
    await setDoc(doc(u1Comments, "c2"), { text: "World", rating: 3 });

    await setDoc(doc(users, "u2"), { name: "Bob" });
    const u2Comments = collection(ctx.firestore, "cg-users/u2/comments");
    await setDoc(doc(u2Comments, "c3"), { text: "Foo", rating: 4 });
    await setDoc(doc(u2Comments, "c4"), { text: "Bar", rating: 1 });
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("T6.1: collectionGroup should query across subcollections with same name", async () => {
    const q = query(collectionGroup(ctx.firestore, "comments"));
    const snap = await getDocs(q);
    expect(snap.size).toBe(4);
  });

  it("T6.2: collectionGroup with where filter should work", async () => {
    const q = query(collectionGroup(ctx.firestore, "comments"), where("rating", ">=", 4));
    const snap = await getDocs(q);
    expect(snap.size).toBe(2);
    snap.forEach((d: QueryDocumentSnapshot) => {
      expect(d.data().rating).toBeGreaterThanOrEqual(4);
    });
  });
});
