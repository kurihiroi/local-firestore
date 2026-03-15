import { describe, it, expect } from "vitest";
import { parseDocumentPath, isCollectionPath, isDocumentPath } from "./path.js";

describe("parseDocumentPath", () => {
  it("トップレベルのドキュメントパスをパースできる", () => {
    const result = parseDocumentPath("users/alice");
    expect(result).toEqual({ collectionPath: "users", documentId: "alice" });
  });

  it("サブコレクションのドキュメントパスをパースできる", () => {
    const result = parseDocumentPath("users/alice/posts/post1");
    expect(result).toEqual({ collectionPath: "users/alice/posts", documentId: "post1" });
  });

  it("不正なパス（奇数セグメント）でエラーを投げる", () => {
    expect(() => parseDocumentPath("users")).toThrow("Invalid document path");
  });

  it("不正なパス（空文字）でエラーを投げる", () => {
    expect(() => parseDocumentPath("")).toThrow("Invalid document path");
  });
});

describe("isCollectionPath", () => {
  it("トップレベルコレクション", () => {
    expect(isCollectionPath("users")).toBe(true);
  });

  it("サブコレクション", () => {
    expect(isCollectionPath("users/alice/posts")).toBe(true);
  });

  it("ドキュメントパスはfalse", () => {
    expect(isCollectionPath("users/alice")).toBe(false);
  });
});

describe("isDocumentPath", () => {
  it("トップレベルドキュメント", () => {
    expect(isDocumentPath("users/alice")).toBe(true);
  });

  it("サブコレクションのドキュメント", () => {
    expect(isDocumentPath("users/alice/posts/post1")).toBe(true);
  });

  it("コレクションパスはfalse", () => {
    expect(isDocumentPath("users")).toBe(false);
  });
});
