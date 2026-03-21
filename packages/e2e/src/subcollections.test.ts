import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
} from "@local-firestore/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestContext } from "./helpers.js";

describe("E2E: Subcollections", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("T13.1: should create and read subcollection documents", async () => {
    const usersCol = collection(ctx.firestore, "sc-users");
    await setDoc(doc(usersCol, "user1"), { name: "Alice" });

    const postsCol = collection(ctx.firestore, "sc-users/user1/posts");
    await setDoc(doc(postsCol, "post1"), { title: "Hello", body: "World" });
    await setDoc(doc(postsCol, "post2"), { title: "Second", body: "Post" });

    const snap = await getDocs(query(postsCol));
    expect(snap.size).toBe(2);

    const post1 = await getDoc(doc(postsCol, "post1"));
    expect(post1.exists()).toBe(true);
    expect(post1.data()).toEqual({ title: "Hello", body: "World" });
  });

  it("T13.2: CRUD operations should work in subcollections", async () => {
    const commentsCol = collection(ctx.firestore, "sc-users/user1/comments");

    // Create
    await setDoc(doc(commentsCol, "c1"), { text: "Nice!", rating: 5 });

    // Read
    const snap = await getDoc(doc(commentsCol, "c1"));
    expect(snap.data()).toEqual({ text: "Nice!", rating: 5 });

    // Update
    await updateDoc(doc(commentsCol, "c1"), { rating: 4 });
    const updated = await getDoc(doc(commentsCol, "c1"));
    expect(updated.data()).toEqual({ text: "Nice!", rating: 4 });

    // Delete
    await deleteDoc(doc(commentsCol, "c1"));
    const deleted = await getDoc(doc(commentsCol, "c1"));
    expect(deleted.exists()).toBe(false);
  });

  it("T13.3: deleting parent document should not delete subcollection", async () => {
    const parentCol = collection(ctx.firestore, "sc-parents");
    await setDoc(doc(parentCol, "p1"), { name: "Parent" });

    const childCol = collection(ctx.firestore, "sc-parents/p1/children");
    await setDoc(doc(childCol, "ch1"), { name: "Child" });

    // Delete parent
    await deleteDoc(doc(parentCol, "p1"));

    // Parent should be gone
    const parentSnap = await getDoc(doc(parentCol, "p1"));
    expect(parentSnap.exists()).toBe(false);

    // Child should still exist
    const childSnap = await getDoc(doc(childCol, "ch1"));
    expect(childSnap.exists()).toBe(true);
    expect(childSnap.data()).toEqual({ name: "Child" });
  });
});
