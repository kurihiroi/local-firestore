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
