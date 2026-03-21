import { describe, expect, it } from "vitest";
import { BuiltinFunctionContext } from "./builtin-functions.js";
import type { EvaluationContext } from "./context.js";
import { RulesEvaluator } from "./evaluator.js";

function makeEvalContext(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    auth: null,
    path: "users/user1",
    documentId: "user1",
    collectionPath: "users",
    operation: "get",
    requestTime: new Date("2025-01-01T00:00:00Z"),
    wildcardBindings: {},
    ...overrides,
  };
}

function createEvaluator(): RulesEvaluator {
  return new RulesEvaluator(new BuiltinFunctionContext(null));
}

describe("RulesEvaluator", () => {
  describe("basic expressions", () => {
    it("should evaluate true", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("true", makeEvalContext())).toBe(true);
    });

    it("should evaluate false", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("false", makeEvalContext())).toBe(false);
    });

    it("should evaluate auth != null", () => {
      const evaluator = createEvaluator();
      expect(
        evaluator.evaluateExpression("auth != null", makeEvalContext({ auth: { uid: "u1" } })),
      ).toBe(true);
      expect(evaluator.evaluateExpression("auth != null", makeEvalContext({ auth: null }))).toBe(
        false,
      );
    });

    it("should evaluate auth == null", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("auth == null", makeEvalContext({ auth: null }))).toBe(
        true,
      );
    });
  });

  describe("member access", () => {
    it("should evaluate auth.uid == documentId", () => {
      const evaluator = createEvaluator();
      expect(
        evaluator.evaluateExpression(
          "auth.uid == documentId",
          makeEvalContext({ auth: { uid: "user1" }, documentId: "user1" }),
        ),
      ).toBe(true);
      expect(
        evaluator.evaluateExpression(
          "auth.uid == documentId",
          makeEvalContext({ auth: { uid: "user2" }, documentId: "user1" }),
        ),
      ).toBe(false);
    });

    it("should evaluate resource.data field access", () => {
      const evaluator = createEvaluator();
      expect(
        evaluator.evaluateExpression(
          "auth.uid == resource.data.authorId",
          makeEvalContext({
            auth: { uid: "user1" },
            existingData: { authorId: "user1", title: "Hello" },
          }),
        ),
      ).toBe(true);
    });
  });

  describe("comparison operators", () => {
    it("should evaluate numeric comparisons", () => {
      const evaluator = createEvaluator();
      const ctx = makeEvalContext({ auth: { uid: "u1" }, requestData: { a: 1, b: 2 } });
      expect(evaluator.evaluateExpression("request.data.keys().size() <= 3", ctx)).toBe(true);
      expect(evaluator.evaluateExpression("request.data.keys().size() > 5", ctx)).toBe(false);
    });

    it("should evaluate < and >=", () => {
      const evaluator = createEvaluator();
      const ctx = makeEvalContext({ auth: { uid: "u1" }, requestData: { a: 1 } });
      expect(evaluator.evaluateExpression("request.data.keys().size() < 2", ctx)).toBe(true);
      expect(evaluator.evaluateExpression("request.data.keys().size() >= 1", ctx)).toBe(true);
    });
  });

  describe("logical operators", () => {
    it("should evaluate AND (short-circuit)", () => {
      const evaluator = createEvaluator();
      expect(
        evaluator.evaluateExpression(
          "auth != null && auth.uid == documentId",
          makeEvalContext({ auth: { uid: "user1" }, documentId: "user1" }),
        ),
      ).toBe(true);

      // short circuit: auth is null, so auth.uid should not be accessed
      expect(
        evaluator.evaluateExpression(
          "auth != null && auth.uid == documentId",
          makeEvalContext({ auth: null, documentId: "user1" }),
        ),
      ).toBe(false);
    });

    it("should evaluate OR (short-circuit)", () => {
      const evaluator = createEvaluator();
      expect(
        evaluator.evaluateExpression(
          "auth == null || auth.uid == documentId",
          makeEvalContext({ auth: null, documentId: "user1" }),
        ),
      ).toBe(true);
    });

    it("should evaluate NOT", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("!false", makeEvalContext())).toBe(true);
      expect(evaluator.evaluateExpression("!true", makeEvalContext())).toBe(false);
    });
  });

  describe("arithmetic operators", () => {
    it("should evaluate addition", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("1 + 2 == 3", makeEvalContext())).toBe(true);
    });

    it("should evaluate multiplication with precedence", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("2 + 3 * 4 == 14", makeEvalContext())).toBe(true);
    });

    it("should evaluate modulo", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("10 % 3 == 1", makeEvalContext())).toBe(true);
    });
  });

  describe("string methods", () => {
    it("should evaluate string.size()", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("'hello'.size() == 5", makeEvalContext())).toBe(true);
    });

    it("should evaluate string.matches()", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("'hello'.matches('^h.*o$')", makeEvalContext())).toBe(
        true,
      );
    });

    it("should evaluate string.contains()", () => {
      const evaluator = createEvaluator();
      expect(
        evaluator.evaluateExpression("'hello world'.contains('world')", makeEvalContext()),
      ).toBe(true);
    });

    it("should evaluate string.lower() and string.upper()", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("'Hello'.lower() == 'hello'", makeEvalContext())).toBe(
        true,
      );
      expect(evaluator.evaluateExpression("'Hello'.upper() == 'HELLO'", makeEvalContext())).toBe(
        true,
      );
    });

    it("should evaluate string.trim()", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("' hello '.trim() == 'hello'", makeEvalContext())).toBe(
        true,
      );
    });

    it("should evaluate string.split()", () => {
      const evaluator = createEvaluator();
      expect(
        evaluator.evaluateExpression("'a,b,c'.split(',').size() == 3", makeEvalContext()),
      ).toBe(true);
    });

    it("should evaluate string.startsWith() and string.endsWith()", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("'hello'.startsWith('he')", makeEvalContext())).toBe(
        true,
      );
      expect(evaluator.evaluateExpression("'hello'.endsWith('lo')", makeEvalContext())).toBe(true);
    });

    it("should evaluate string.replace()", () => {
      const evaluator = createEvaluator();
      expect(
        evaluator.evaluateExpression("'hello'.replace('l', 'r') == 'herro'", makeEvalContext()),
      ).toBe(true);
    });
  });

  describe("list methods", () => {
    it("should evaluate list.size()", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("[1, 2, 3].size() == 3", makeEvalContext())).toBe(true);
    });

    it("should evaluate list.hasAny()", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("[1, 2, 3].hasAny([2, 4])", makeEvalContext())).toBe(
        true,
      );
      expect(evaluator.evaluateExpression("[1, 2, 3].hasAny([4, 5])", makeEvalContext())).toBe(
        false,
      );
    });

    it("should evaluate list.hasAll()", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("[1, 2, 3].hasAll([1, 2])", makeEvalContext())).toBe(
        true,
      );
      expect(evaluator.evaluateExpression("[1, 2, 3].hasAll([1, 4])", makeEvalContext())).toBe(
        false,
      );
    });

    it("should evaluate list.hasOnly()", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("[1, 2].hasOnly([1, 2, 3])", makeEvalContext())).toBe(
        true,
      );
      expect(evaluator.evaluateExpression("[1, 4].hasOnly([1, 2, 3])", makeEvalContext())).toBe(
        false,
      );
    });

    it("should evaluate list.concat()", () => {
      const evaluator = createEvaluator();
      expect(
        evaluator.evaluateExpression("[1, 2].concat([3, 4]).size() == 4", makeEvalContext()),
      ).toBe(true);
    });

    it("should evaluate list.join()", () => {
      const evaluator = createEvaluator();
      expect(
        evaluator.evaluateExpression("['a', 'b', 'c'].join(',') == 'a,b,c'", makeEvalContext()),
      ).toBe(true);
    });
  });

  describe("map operations", () => {
    it("should evaluate map.size()", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("{'a': 1, 'b': 2}.size() == 2", makeEvalContext())).toBe(
        true,
      );
    });

    it("should evaluate map.keys()", () => {
      const evaluator = createEvaluator();
      expect(
        evaluator.evaluateExpression("{'a': 1, 'b': 2}.keys().size() == 2", makeEvalContext()),
      ).toBe(true);
    });

    it("should evaluate map.get() with default", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("{'a': 1}.get('b', 0) == 0", makeEvalContext())).toBe(
        true,
      );
      expect(evaluator.evaluateExpression("{'a': 1}.get('a', 0) == 1", makeEvalContext())).toBe(
        true,
      );
    });

    it("should evaluate key in map", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("'a' in {'a': 1, 'b': 2}", makeEvalContext())).toBe(true);
      expect(evaluator.evaluateExpression("'c' in {'a': 1, 'b': 2}", makeEvalContext())).toBe(
        false,
      );
    });
  });

  describe("set operations", () => {
    it("should evaluate list.toSet()", () => {
      const evaluator = createEvaluator();
      expect(
        evaluator.evaluateExpression("[1, 2, 2, 3].toSet().size() == 3", makeEvalContext()),
      ).toBe(true);
    });

    it("should evaluate set.hasAll()", () => {
      const evaluator = createEvaluator();
      expect(
        evaluator.evaluateExpression("[1, 2, 3].toSet().hasAll([1, 2])", makeEvalContext()),
      ).toBe(true);
    });
  });

  describe("type checking", () => {
    it("should evaluate is operator", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("'hello' is string", makeEvalContext())).toBe(true);
      expect(evaluator.evaluateExpression("42 is int", makeEvalContext())).toBe(true);
      expect(evaluator.evaluateExpression("3.14 is float", makeEvalContext())).toBe(true);
      expect(evaluator.evaluateExpression("true is bool", makeEvalContext())).toBe(true);
      expect(evaluator.evaluateExpression("null is null", makeEvalContext())).toBe(true);
    });

    it("should evaluate is number (int or float)", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("42 is number", makeEvalContext())).toBe(true);
      expect(evaluator.evaluateExpression("3.14 is number", makeEvalContext())).toBe(true);
    });
  });

  describe("ternary operator", () => {
    it("should evaluate conditional expression", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("true ? true : false", makeEvalContext())).toBe(true);
      expect(evaluator.evaluateExpression("false ? true : false", makeEvalContext())).toBe(false);
    });
  });

  describe("in operator", () => {
    it("should evaluate value in list", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("2 in [1, 2, 3]", makeEvalContext())).toBe(true);
      expect(evaluator.evaluateExpression("4 in [1, 2, 3]", makeEvalContext())).toBe(false);
    });
  });

  describe("math namespace", () => {
    it("should evaluate math.abs()", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("math.abs(-5) == 5", makeEvalContext())).toBe(true);
    });

    it("should evaluate math.ceil() and math.floor()", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("math.ceil(1.5) == 2", makeEvalContext())).toBe(true);
      expect(evaluator.evaluateExpression("math.floor(1.5) == 1", makeEvalContext())).toBe(true);
    });

    it("should evaluate math.pow()", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("math.pow(2, 3) == 8", makeEvalContext())).toBe(true);
    });
  });

  describe("timestamp operations", () => {
    it("should evaluate request.time comparisons", () => {
      const evaluator = createEvaluator();
      const ctx = makeEvalContext({ requestTime: new Date("2025-06-15T00:00:00Z") });
      expect(evaluator.evaluateExpression("request.time.year() == 2025", ctx)).toBe(true);
      expect(evaluator.evaluateExpression("request.time.month() == 6", ctx)).toBe(true);
      expect(evaluator.evaluateExpression("request.time.day() == 15", ctx)).toBe(true);
    });

    it("should evaluate timestamp.date() creation", () => {
      const evaluator = createEvaluator();
      expect(
        evaluator.evaluateExpression(
          "request.time < timestamp.date(2030, 1, 1)",
          makeEvalContext({ requestTime: new Date("2025-01-01T00:00:00Z") }),
        ),
      ).toBe(true);
    });
  });

  describe("duration operations", () => {
    it("should evaluate duration.value()", () => {
      const evaluator = createEvaluator();
      expect(
        evaluator.evaluateExpression("duration.value(1, 'h').hours() == 1", makeEvalContext()),
      ).toBe(true);
    });

    it("should evaluate duration.time()", () => {
      const evaluator = createEvaluator();
      expect(
        evaluator.evaluateExpression(
          "duration.time(1, 30, 0, 0).minutes() == 90",
          makeEvalContext(),
        ),
      ).toBe(true);
    });
  });

  describe("latlng operations", () => {
    it("should evaluate latlng.value()", () => {
      const evaluator = createEvaluator();
      expect(
        evaluator.evaluateExpression(
          "latlng.value(35.6, 139.7).latitude() == 35.6",
          makeEvalContext(),
        ),
      ).toBe(true);
    });
  });

  describe("custom functions", () => {
    it("should evaluate custom function definition and call", () => {
      const evaluator = createEvaluator();
      expect(
        evaluator.evaluateExpression(
          "function isOwner(uid) { return uid == documentId; } isOwner(auth.uid)",
          makeEvalContext({ auth: { uid: "user1" }, documentId: "user1" }),
        ),
      ).toBe(true);
    });

    it("should evaluate custom function with let binding", () => {
      const evaluator = createEvaluator();
      expect(
        evaluator.evaluateExpression(
          "function check(x) { let doubled = x * 2; return doubled > 5; } check(3)",
          makeEvalContext(),
        ),
      ).toBe(true);
    });
  });

  describe("grouping with parentheses", () => {
    it("should respect parentheses in expressions", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("(1 + 2) * 3 == 9", makeEvalContext())).toBe(true);
    });
  });

  describe("request.resource.data", () => {
    it("should access request.resource.data for write operations", () => {
      const evaluator = createEvaluator();
      expect(
        evaluator.evaluateExpression(
          "request.resource.data.keys().size() <= 3",
          makeEvalContext({
            auth: { uid: "user1" },
            operation: "create",
            requestData: { name: "Alice", age: 30 },
          }),
        ),
      ).toBe(true);
    });

    it("should validate request.resource.data fields", () => {
      const evaluator = createEvaluator();
      expect(
        evaluator.evaluateExpression(
          "request.resource.data.name is string",
          makeEvalContext({
            operation: "create",
            requestData: { name: "Alice" },
          }),
        ),
      ).toBe(true);
    });
  });

  describe("wildcard bindings", () => {
    it("should access wildcard variables", () => {
      const evaluator = createEvaluator();
      expect(
        evaluator.evaluateExpression(
          "userId == auth.uid",
          makeEvalContext({
            auth: { uid: "user1" },
            wildcardBindings: { userId: "user1" },
          }),
        ),
      ).toBe(true);
    });
  });

  describe("map diff", () => {
    it("should evaluate map.diff()", () => {
      const evaluator = createEvaluator();
      expect(
        evaluator.evaluateExpression(
          "{'a': 1, 'b': 2}.diff({'a': 1, 'c': 3}).addedKeys().size() == 1",
          makeEvalContext(),
        ),
      ).toBe(true);
    });
  });

  describe("hashing", () => {
    it("should evaluate hashing.md5()", () => {
      const evaluator = createEvaluator();
      // md5 returns bytes, check its size
      expect(
        evaluator.evaluateExpression("hashing.md5('hello').size() == 16", makeEvalContext()),
      ).toBe(true);
    });

    it("should evaluate hashing.sha256()", () => {
      const evaluator = createEvaluator();
      expect(
        evaluator.evaluateExpression("hashing.sha256('hello').size() == 32", makeEvalContext()),
      ).toBe(true);
    });
  });

  describe("index access", () => {
    it("should access list by index", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("[10, 20, 30][1] == 20", makeEvalContext())).toBe(true);
    });

    it("should access map by string key", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("{'a': 1, 'b': 2}['a'] == 1", makeEvalContext())).toBe(
        true,
      );
    });
  });

  describe("type casting", () => {
    it("should cast with int()", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("int(3.7) == 3", makeEvalContext())).toBe(true);
    });

    it("should cast with float()", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("float(3) == 3.0", makeEvalContext())).toBe(true);
    });

    it("should cast with string()", () => {
      const evaluator = createEvaluator();
      expect(evaluator.evaluateExpression("string(42) == '42'", makeEvalContext())).toBe(true);
    });
  });
});
