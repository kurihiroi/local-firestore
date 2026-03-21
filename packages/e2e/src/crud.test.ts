import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  setDoc,
  updateDoc,
} from "@local-firestore/client";
import { startTestServer, type TestContext } from "./helpers.js";

describe("E2E: CRUD operations", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("should create and read a document with setDoc/getDoc", async () => {
    const ref = doc(collection(ctx.firestore, "users"), "alice");
    await setDoc(ref, { name: "Alice", age: 30 });

    const snap = await getDoc(ref);
    expect(snap.exists()).toBe(true);
    expect(snap.data()).toEqual({ name: "Alice", age: 30 });
    expect(snap.id).toBe("alice");
  });

  it("should add a document with auto-generated ID", async () => {
    const colRef = collection(ctx.firestore, "posts");
    const ref = await addDoc(colRef, { title: "Hello World", content: "First post" });

    expect(ref.id).toBeDefined();
    expect(ref.path).toContain("posts/");

    const snap = await getDoc(ref);
    expect(snap.exists()).toBe(true);
    expect(snap.data()?.title).toBe("Hello World");
  });

  it("should update a document", async () => {
    const ref = doc(collection(ctx.firestore, "users"), "bob");
    await setDoc(ref, { name: "Bob", age: 25 });

    await updateDoc(ref, { age: 26 });

    const snap = await getDoc(ref);
    expect(snap.data()).toEqual({ name: "Bob", age: 26 });
  });

  it("should delete a document", async () => {
    const ref = doc(collection(ctx.firestore, "users"), "charlie");
    await setDoc(ref, { name: "Charlie" });

    await deleteDoc(ref);

    const snap = await getDoc(ref);
    expect(snap.exists()).toBe(false);
  });

  it("should return non-existent document as not exists", async () => {
    const ref = doc(collection(ctx.firestore, "users"), "nonexistent");
    const snap = await getDoc(ref);
    expect(snap.exists()).toBe(false);
    expect(snap.data()).toBeUndefined();
  });

  it("should overwrite document with setDoc", async () => {
    const ref = doc(collection(ctx.firestore, "users"), "dave");
    await setDoc(ref, { name: "Dave", age: 40, email: "dave@example.com" });
    await setDoc(ref, { name: "Dave Updated" });

    const snap = await getDoc(ref);
    expect(snap.data()).toEqual({ name: "Dave Updated" });
  });
});
