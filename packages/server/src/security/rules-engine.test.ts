import { describe, expect, it } from "vitest";
import {
  createAuthRequiredRules,
  createOpenRules,
  type RuleContext,
  type SecurityRules,
  SecurityRulesEngine,
} from "./rules-engine.js";

function makeContext(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    auth: null,
    path: "users/user1",
    documentId: "user1",
    collectionPath: "users",
    ...overrides,
  };
}

describe("SecurityRulesEngine", () => {
  describe("basic boolean rules", () => {
    it("should allow when rule is true", () => {
      const engine = new SecurityRulesEngine({
        rules: { users: { read: true, write: true } },
      });
      const result = engine.evaluate("get", makeContext());
      expect(result.allowed).toBe(true);
    });

    it("should deny when rule is false", () => {
      const engine = new SecurityRulesEngine({
        rules: { users: { read: false, write: false } },
      });
      const result = engine.evaluate("get", makeContext());
      expect(result.allowed).toBe(false);
    });

    it("should deny when no rule matches", () => {
      const engine = new SecurityRulesEngine({ rules: {} });
      const result = engine.evaluate("get", makeContext());
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("No rule found");
    });
  });

  describe("operation resolution", () => {
    it("should fall back from get to read", () => {
      const engine = new SecurityRulesEngine({
        rules: { users: { read: true } },
      });
      expect(engine.evaluate("get", makeContext()).allowed).toBe(true);
    });

    it("should fall back from list to read", () => {
      const engine = new SecurityRulesEngine({
        rules: { users: { read: true } },
      });
      expect(engine.evaluate("list", makeContext()).allowed).toBe(true);
    });

    it("should fall back from create to write", () => {
      const engine = new SecurityRulesEngine({
        rules: { users: { write: true } },
      });
      expect(engine.evaluate("create", makeContext()).allowed).toBe(true);
    });

    it("should fall back from update to write", () => {
      const engine = new SecurityRulesEngine({
        rules: { users: { write: true } },
      });
      expect(engine.evaluate("update", makeContext()).allowed).toBe(true);
    });

    it("should fall back from delete to write", () => {
      const engine = new SecurityRulesEngine({
        rules: { users: { write: true } },
      });
      expect(engine.evaluate("delete", makeContext()).allowed).toBe(true);
    });

    it("should prefer specific rule over fallback", () => {
      const engine = new SecurityRulesEngine({
        rules: { users: { read: false, get: true } },
      });
      expect(engine.evaluate("get", makeContext()).allowed).toBe(true);
      expect(engine.evaluate("list", makeContext()).allowed).toBe(false);
    });
  });

  describe("wildcard collection", () => {
    it("should match {collection} wildcard", () => {
      const engine = new SecurityRulesEngine({
        rules: { "{collection}": { read: true, write: true } },
      });
      expect(engine.evaluate("get", makeContext()).allowed).toBe(true);
      expect(engine.evaluate("get", makeContext({ collectionPath: "posts" })).allowed).toBe(true);
    });

    it("should prefer exact match over wildcard", () => {
      const engine = new SecurityRulesEngine({
        rules: {
          users: { read: true, write: false },
          "{collection}": { read: false, write: false },
        },
      });
      expect(engine.evaluate("get", makeContext()).allowed).toBe(true);
      expect(engine.evaluate("get", makeContext({ collectionPath: "posts" })).allowed).toBe(false);
    });
  });

  describe("expression: auth != null", () => {
    const rules: SecurityRules = {
      rules: { users: { read: "auth != null", write: "auth != null" } },
    };

    it("should allow authenticated user", () => {
      const engine = new SecurityRulesEngine(rules);
      const result = engine.evaluate("get", makeContext({ auth: { uid: "user1" } }));
      expect(result.allowed).toBe(true);
    });

    it("should deny unauthenticated user", () => {
      const engine = new SecurityRulesEngine(rules);
      const result = engine.evaluate("get", makeContext({ auth: null }));
      expect(result.allowed).toBe(false);
    });
  });

  describe("expression: auth.uid == documentId", () => {
    const rules: SecurityRules = {
      rules: { users: { read: true, write: "auth.uid == documentId" } },
    };

    it("should allow when uid matches document ID", () => {
      const engine = new SecurityRulesEngine(rules);
      const result = engine.evaluate(
        "update",
        makeContext({ auth: { uid: "user1" }, documentId: "user1" }),
      );
      expect(result.allowed).toBe(true);
    });

    it("should deny when uid does not match document ID", () => {
      const engine = new SecurityRulesEngine(rules);
      const result = engine.evaluate(
        "update",
        makeContext({ auth: { uid: "user2" }, documentId: "user1" }),
      );
      expect(result.allowed).toBe(false);
    });
  });

  describe("expression: auth.uid == resource.data.<field>", () => {
    const rules: SecurityRules = {
      rules: { posts: { read: true, write: "auth.uid == resource.data.authorId" } },
    };

    it("should allow when uid matches resource field", () => {
      const engine = new SecurityRulesEngine(rules);
      const result = engine.evaluate("update", {
        auth: { uid: "user1" },
        path: "posts/post1",
        documentId: "post1",
        collectionPath: "posts",
        existingData: { authorId: "user1", title: "Hello" },
      });
      expect(result.allowed).toBe(true);
    });

    it("should deny when uid does not match resource field", () => {
      const engine = new SecurityRulesEngine(rules);
      const result = engine.evaluate("update", {
        auth: { uid: "user2" },
        path: "posts/post1",
        documentId: "post1",
        collectionPath: "posts",
        existingData: { authorId: "user1", title: "Hello" },
      });
      expect(result.allowed).toBe(false);
    });
  });

  describe("expression: request.data.keys().size() <= N", () => {
    const rules: SecurityRules = {
      rules: { users: { write: "request.data.keys().size() <= 3" } },
    };

    it("should allow when field count is within limit", () => {
      const engine = new SecurityRulesEngine(rules);
      const result = engine.evaluate(
        "create",
        makeContext({
          auth: { uid: "user1" },
          requestData: { name: "Alice", age: 30 },
        }),
      );
      expect(result.allowed).toBe(true);
    });

    it("should deny when field count exceeds limit", () => {
      const engine = new SecurityRulesEngine(rules);
      const result = engine.evaluate(
        "create",
        makeContext({
          auth: { uid: "user1" },
          requestData: { a: 1, b: 2, c: 3, d: 4 },
        }),
      );
      expect(result.allowed).toBe(false);
    });
  });

  describe("compound expressions", () => {
    it("should evaluate AND expressions", () => {
      const engine = new SecurityRulesEngine({
        rules: { users: { write: "auth != null && auth.uid == documentId" } },
      });

      expect(
        engine.evaluate("update", makeContext({ auth: { uid: "user1" }, documentId: "user1" }))
          .allowed,
      ).toBe(true);

      expect(
        engine.evaluate("update", makeContext({ auth: null, documentId: "user1" })).allowed,
      ).toBe(false);
    });

    it("should evaluate OR expressions", () => {
      const engine = new SecurityRulesEngine({
        rules: { data: { read: "auth == null || auth != null" } },
      });

      expect(
        engine.evaluate("get", makeContext({ auth: null, collectionPath: "data" })).allowed,
      ).toBe(true);
    });
  });

  describe("subcollections", () => {
    it("should evaluate subcollection rules", () => {
      const engine = new SecurityRulesEngine({
        rules: {
          users: {
            read: true,
            write: true,
            subcollections: {
              posts: { read: true, write: "auth.uid == documentId" },
            },
          },
        },
      });

      // users コレクション自体は自由
      expect(engine.evaluate("get", makeContext()).allowed).toBe(true);
    });
  });

  describe("recursive wildcard ({name=**})", () => {
    const engine = new SecurityRulesEngine({
      rules: {
        "{path=**}": {
          subcollections: {
            comments: { read: true, write: "auth != null" },
          },
        },
        users: { read: "auth != null", write: false },
      },
    });

    it("should match multiple segments with recursive wildcard", () => {
      // posts/p1/comments: {path=**} が "posts/p1" を消費して comments にマッチ
      const result = engine.evaluate(
        "get",
        makeContext({
          path: "posts/p1/comments/c1",
          collectionPath: "posts/p1/comments",
          documentId: "c1",
        }),
      );
      expect(result.allowed).toBe(true);
    });

    it("should match deeply nested paths", () => {
      const result = engine.evaluate(
        "get",
        makeContext({
          path: "a/b/c/d/comments/c1",
          collectionPath: "a/b/c/d/comments",
          documentId: "c1",
        }),
      );
      expect(result.allowed).toBe(true);
    });

    it("should match zero segments (rules_version 2 semantics)", () => {
      // トップレベルの comments コレクションにもマッチする
      const result = engine.evaluate(
        "get",
        makeContext({ path: "comments/c1", collectionPath: "comments", documentId: "c1" }),
      );
      expect(result.allowed).toBe(true);
    });

    it("should bind consumed segments to the wildcard variable", () => {
      const bindingEngine = new SecurityRulesEngine({
        rules: {
          "{path=**}": {
            subcollections: {
              comments: { read: "path == 'posts/p1'" },
            },
          },
        },
      });
      expect(
        bindingEngine.evaluate(
          "get",
          makeContext({
            path: "posts/p1/comments/c1",
            collectionPath: "posts/p1/comments",
            documentId: "c1",
          }),
        ).allowed,
      ).toBe(true);
      expect(
        bindingEngine.evaluate(
          "get",
          makeContext({
            path: "posts/p2/comments/c1",
            collectionPath: "posts/p2/comments",
            documentId: "c1",
          }),
        ).allowed,
      ).toBe(false);
    });

    it("should prefer exact match over recursive wildcard", () => {
      // users は exact match のルール（write: false）が優先される
      const result = engine.evaluate(
        "create",
        makeContext({ collectionPath: "users", auth: { uid: "u1" } }),
      );
      expect(result.allowed).toBe(false);
    });

    it("should match whole path as a leaf recursive wildcard", () => {
      const catchAll = new SecurityRulesEngine({
        rules: { "{document=**}": { read: true, write: false } },
      });
      expect(
        catchAll.evaluate(
          "get",
          makeContext({
            path: "a/b/c/d/e/f",
            collectionPath: "a/b/c/d/e",
            documentId: "f",
          }),
        ).allowed,
      ).toBe(true);
    });
  });

  describe("needsPerDocumentListEvaluation", () => {
    it("should be false for boolean rules", () => {
      const engine = new SecurityRulesEngine({ rules: { posts: { read: true } } });
      expect(engine.needsPerDocumentListEvaluation("posts")).toBe(false);
    });

    it("should be false when rule does not reference resource", () => {
      const engine = new SecurityRulesEngine({
        rules: { posts: { read: "request.auth != null" } },
      });
      expect(engine.needsPerDocumentListEvaluation("posts")).toBe(false);
    });

    it("should be false when only request.resource is referenced", () => {
      const engine = new SecurityRulesEngine({
        rules: { posts: { list: "request.auth != null", create: "request.resource.data.v == 1" } },
      });
      expect(engine.needsPerDocumentListEvaluation("posts")).toBe(false);
    });

    it("should be true when rule references resource", () => {
      const engine = new SecurityRulesEngine({
        rules: { posts: { read: "resource.data.visibility == 'public'" } },
      });
      expect(engine.needsPerDocumentListEvaluation("posts")).toBe(true);
    });

    it("should be true when rule references documentId", () => {
      const engine = new SecurityRulesEngine({
        rules: { posts: { read: "auth.uid == documentId" } },
      });
      expect(engine.needsPerDocumentListEvaluation("posts")).toBe(true);
    });

    it("should be true when custom function references resource", () => {
      const engine = new SecurityRulesEngine({
        rules: {
          posts: {
            functions: "function isPublic() { return resource.data.visibility == 'public'; }",
            read: "isPublic()",
          },
        },
      });
      expect(engine.needsPerDocumentListEvaluation("posts")).toBe(true);
    });

    it("should be true for collection group queries", () => {
      const engine = new SecurityRulesEngine({ rules: { posts: { read: true } } });
      expect(engine.needsPerDocumentListEvaluation("posts", true)).toBe(true);
    });

    it("should be false when request.query is referenced without resource", () => {
      const engine = new SecurityRulesEngine({
        rules: { posts: { list: "request.query.limit != null && request.query.limit <= 10" } },
      });
      expect(engine.needsPerDocumentListEvaluation("posts")).toBe(false);
    });
  });

  describe("evaluateListQuery (per-document evaluation)", () => {
    const visibilityRules: SecurityRules = {
      rules: {
        posts: { list: "resource.data.visibility == 'public'", get: true, write: true },
      },
    };

    it("should allow when all documents satisfy the rule", () => {
      const engine = new SecurityRulesEngine(visibilityRules);
      const result = engine.evaluateListQuery({ auth: null, collectionPath: "posts" }, [
        { path: "posts/p1", data: { visibility: "public" } },
        { path: "posts/p2", data: { visibility: "public" } },
      ]);
      expect(result.allowed).toBe(true);
    });

    it("should deny the whole query when any document is denied", () => {
      const engine = new SecurityRulesEngine(visibilityRules);
      const result = engine.evaluateListQuery({ auth: null, collectionPath: "posts" }, [
        { path: "posts/p1", data: { visibility: "public" } },
        { path: "posts/p2", data: { visibility: "private" } },
      ]);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("posts/p2");
    });

    it("should evaluate once at collection level for empty results", () => {
      const engine = new SecurityRulesEngine(visibilityRules);
      // resource == null のため評価エラーとなり拒否される（本家同様）
      const result = engine.evaluateListQuery({ auth: null, collectionPath: "posts" }, []);
      expect(result.allowed).toBe(false);
    });

    it("should shortcut to single evaluation when rule does not need documents", () => {
      const engine = new SecurityRulesEngine({
        rules: { posts: { read: "auth != null" } },
      });
      expect(
        engine.evaluateListQuery({ auth: { uid: "u1" }, collectionPath: "posts" }, [
          { path: "posts/p1", data: {} },
        ]).allowed,
      ).toBe(true);
      expect(
        engine.evaluateListQuery({ auth: null, collectionPath: "posts" }, [
          { path: "posts/p1", data: {} },
        ]).allowed,
      ).toBe(false);
    });

    it("should bind request.query for list evaluation", () => {
      const engine = new SecurityRulesEngine({
        rules: { posts: { list: "request.query.limit != null && request.query.limit <= 10" } },
      });
      expect(
        engine.evaluateListQuery(
          { auth: null, collectionPath: "posts", queryParams: { limit: 5 } },
          [],
        ).allowed,
      ).toBe(true);
      expect(
        engine.evaluateListQuery(
          { auth: null, collectionPath: "posts", queryParams: { limit: 100 } },
          [],
        ).allowed,
      ).toBe(false);
      // limit 未指定は null 束縛 → 拒否
      expect(
        engine.evaluateListQuery({ auth: null, collectionPath: "posts", queryParams: {} }, [])
          .allowed,
      ).toBe(false);
    });

    it("should evaluate collection group documents against their real paths", () => {
      const engine = new SecurityRulesEngine({
        rules: {
          "{path=**}": {
            subcollections: {
              comments: { list: "resource.data.visibility == 'public'" },
            },
          },
        },
      });
      const allowed = engine.evaluateListQuery(
        { auth: null, collectionPath: "comments", collectionGroup: true },
        [
          { path: "posts/p1/comments/c1", data: { visibility: "public" } },
          { path: "articles/a1/comments/c2", data: { visibility: "public" } },
        ],
      );
      expect(allowed.allowed).toBe(true);

      const denied = engine.evaluateListQuery(
        { auth: null, collectionPath: "comments", collectionGroup: true },
        [{ path: "posts/p1/comments/c1", data: { visibility: "private" } }],
      );
      expect(denied.allowed).toBe(false);
    });
  });

  describe("preset rules", () => {
    it("createOpenRules should allow everything", () => {
      const engine = new SecurityRulesEngine(createOpenRules());
      expect(engine.evaluate("get", makeContext()).allowed).toBe(true);
      expect(engine.evaluate("create", makeContext()).allowed).toBe(true);
      expect(engine.evaluate("delete", makeContext()).allowed).toBe(true);
    });

    it("createAuthRequiredRules should require auth", () => {
      const engine = new SecurityRulesEngine(createAuthRequiredRules());
      expect(engine.evaluate("get", makeContext({ auth: null })).allowed).toBe(false);
      expect(engine.evaluate("get", makeContext({ auth: { uid: "u1" } })).allowed).toBe(true);
    });
  });
});
