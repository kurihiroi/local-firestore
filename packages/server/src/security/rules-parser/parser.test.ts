import { describe, expect, it } from "vitest";
import { Parser } from "./parser.js";

describe("Parser", () => {
  describe("literals", () => {
    it("should parse true", () => {
      const expr = Parser.parseExpression("true");
      expect(expr).toEqual({ type: "BoolLiteral", value: true });
    });

    it("should parse false", () => {
      const expr = Parser.parseExpression("false");
      expect(expr).toEqual({ type: "BoolLiteral", value: false });
    });

    it("should parse null", () => {
      const expr = Parser.parseExpression("null");
      expect(expr).toEqual({ type: "NullLiteral" });
    });

    it("should parse integer", () => {
      const expr = Parser.parseExpression("42");
      expect(expr).toEqual({ type: "IntLiteral", value: 42 });
    });

    it("should parse float", () => {
      const expr = Parser.parseExpression("3.14");
      expect(expr).toEqual({ type: "FloatLiteral", value: 3.14 });
    });

    it("should parse string", () => {
      const expr = Parser.parseExpression("'hello'");
      expect(expr).toEqual({ type: "StringLiteral", value: "hello" });
    });
  });

  describe("identifiers", () => {
    it("should parse identifier", () => {
      const expr = Parser.parseExpression("auth");
      expect(expr).toEqual({ type: "Identifier", name: "auth" });
    });
  });

  describe("member access", () => {
    it("should parse member expression", () => {
      const expr = Parser.parseExpression("auth.uid");
      expect(expr).toEqual({
        type: "MemberExpression",
        object: { type: "Identifier", name: "auth" },
        property: "uid",
      });
    });

    it("should parse chained member expression", () => {
      const expr = Parser.parseExpression("resource.data.field");
      expect(expr.type).toBe("MemberExpression");
    });
  });

  describe("binary expressions", () => {
    it("should parse equality", () => {
      const expr = Parser.parseExpression("auth != null");
      expect(expr).toEqual({
        type: "BinaryExpression",
        operator: "!=",
        left: { type: "Identifier", name: "auth" },
        right: { type: "NullLiteral" },
      });
    });

    it("should parse comparison", () => {
      const expr = Parser.parseExpression("a < b");
      expect(expr.type).toBe("BinaryExpression");
      if (expr.type === "BinaryExpression") {
        expect(expr.operator).toBe("<");
      }
    });

    it("should parse arithmetic", () => {
      const expr = Parser.parseExpression("a + b * c");
      // Should be a + (b * c) due to precedence
      expect(expr.type).toBe("BinaryExpression");
      if (expr.type === "BinaryExpression") {
        expect(expr.operator).toBe("+");
        expect(expr.right.type).toBe("BinaryExpression");
      }
    });

    it("should parse logical AND", () => {
      const expr = Parser.parseExpression("a && b");
      expect(expr.type).toBe("BinaryExpression");
      if (expr.type === "BinaryExpression") {
        expect(expr.operator).toBe("&&");
      }
    });

    it("should parse logical OR", () => {
      const expr = Parser.parseExpression("a || b");
      expect(expr.type).toBe("BinaryExpression");
      if (expr.type === "BinaryExpression") {
        expect(expr.operator).toBe("||");
      }
    });

    it("should parse in operator", () => {
      const expr = Parser.parseExpression("x in list");
      expect(expr.type).toBe("BinaryExpression");
      if (expr.type === "BinaryExpression") {
        expect(expr.operator).toBe("in");
      }
    });
  });

  describe("unary expressions", () => {
    it("should parse negation", () => {
      const expr = Parser.parseExpression("!a");
      expect(expr).toEqual({
        type: "UnaryExpression",
        operator: "!",
        operand: { type: "Identifier", name: "a" },
      });
    });

    it("should parse negative number", () => {
      const expr = Parser.parseExpression("-1");
      expect(expr.type).toBe("UnaryExpression");
    });
  });

  describe("conditional expression", () => {
    it("should parse ternary", () => {
      const expr = Parser.parseExpression("a ? b : c");
      expect(expr.type).toBe("ConditionalExpression");
    });
  });

  describe("is expression", () => {
    it("should parse is type check", () => {
      const expr = Parser.parseExpression("x is string");
      expect(expr).toEqual({
        type: "IsExpression",
        value: { type: "Identifier", name: "x" },
        targetType: "string",
      });
    });
  });

  describe("call expressions", () => {
    it("should parse function call", () => {
      const expr = Parser.parseExpression("exists(path)");
      expect(expr.type).toBe("CallExpression");
    });

    it("should parse method call", () => {
      const expr = Parser.parseExpression("str.size()");
      expect(expr.type).toBe("CallExpression");
    });

    it("should parse chained method calls", () => {
      const expr = Parser.parseExpression("data.keys().size()");
      expect(expr.type).toBe("CallExpression");
    });
  });

  describe("list and map literals", () => {
    it("should parse list literal", () => {
      const expr = Parser.parseExpression("[1, 2, 3]");
      expect(expr.type).toBe("ListExpression");
      if (expr.type === "ListExpression") {
        expect(expr.elements.length).toBe(3);
      }
    });

    it("should parse map literal", () => {
      const expr = Parser.parseExpression("{'key': 'value'}");
      expect(expr.type).toBe("MapExpression");
    });

    it("should parse empty list", () => {
      const expr = Parser.parseExpression("[]");
      expect(expr).toEqual({ type: "ListExpression", elements: [] });
    });
  });

  describe("grouping", () => {
    it("should parse parenthesized expression", () => {
      const expr = Parser.parseExpression("(a + b) * c");
      expect(expr.type).toBe("BinaryExpression");
      if (expr.type === "BinaryExpression") {
        expect(expr.operator).toBe("*");
      }
    });
  });

  describe("complex expressions", () => {
    it("should parse auth.uid == resource.data.authorId", () => {
      const expr = Parser.parseExpression("auth.uid == resource.data.authorId");
      expect(expr.type).toBe("BinaryExpression");
    });

    it("should parse request.resource.data.keys().size() <= 3", () => {
      const expr = Parser.parseExpression("request.resource.data.keys().size() <= 3");
      expect(expr.type).toBe("BinaryExpression");
    });

    it("should parse compound AND expression", () => {
      const expr = Parser.parseExpression("auth != null && auth.uid == documentId");
      expect(expr.type).toBe("BinaryExpression");
      if (expr.type === "BinaryExpression") {
        expect(expr.operator).toBe("&&");
      }
    });
  });

  describe("function declarations", () => {
    it("should parse function declaration with expression", () => {
      const result = Parser.parseRule(
        "function isOwner(uid) { return uid == documentId; } isOwner(auth.uid)",
      );
      expect(result.functions.length).toBe(1);
      expect(result.functions[0].name).toBe("isOwner");
      expect(result.functions[0].params).toEqual(["uid"]);
    });

    it("should parse function with let bindings", () => {
      const result = Parser.parseRule(
        "function check(x) { let y = x + 1; return y > 0; } check(5)",
      );
      expect(result.functions[0].bindings.length).toBe(1);
      expect(result.functions[0].bindings[0].name).toBe("y");
    });
  });
});
