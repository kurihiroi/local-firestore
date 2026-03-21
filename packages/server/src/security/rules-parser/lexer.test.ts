import { describe, expect, it } from "vitest";
import { Lexer } from "./lexer.js";

describe("Lexer", () => {
  it("should tokenize simple boolean expression", () => {
    const tokens = new Lexer("true").tokenize();
    expect(tokens[0].type).toBe("True");
    expect(tokens[1].type).toBe("EOF");
  });

  it("should tokenize comparison expression", () => {
    const tokens = new Lexer("auth != null").tokenize();
    expect(tokens.map((t) => t.type)).toEqual(["Identifier", "BangEq", "Null", "EOF"]);
  });

  it("should tokenize member access", () => {
    const tokens = new Lexer("auth.uid == documentId").tokenize();
    expect(tokens.map((t) => t.type)).toEqual([
      "Identifier", "Dot", "Identifier", "EqEq", "Identifier", "EOF",
    ]);
  });

  it("should tokenize method calls", () => {
    const tokens = new Lexer("request.data.keys().size()").tokenize();
    expect(tokens.map((t) => t.type)).toEqual([
      "Identifier", "Dot", "Identifier", "Dot", "Identifier", "LParen", "RParen",
      "Dot", "Identifier", "LParen", "RParen", "EOF",
    ]);
  });

  it("should tokenize number literals", () => {
    const tokens = new Lexer("42").tokenize();
    expect(tokens[0]).toEqual({ type: "Number", value: "42", pos: 0 });
  });

  it("should tokenize float literals", () => {
    const tokens = new Lexer("3.14").tokenize();
    expect(tokens[0]).toEqual({ type: "Number", value: "3.14", pos: 0 });
  });

  it("should tokenize string literals", () => {
    const tokens = new Lexer("'hello'").tokenize();
    expect(tokens[0]).toEqual({ type: "String", value: "hello", pos: 0 });
  });

  it("should tokenize double-quoted strings", () => {
    const tokens = new Lexer('"world"').tokenize();
    expect(tokens[0]).toEqual({ type: "String", value: "world", pos: 0 });
  });

  it("should handle escape sequences in strings", () => {
    const tokens = new Lexer("'hello\\nworld'").tokenize();
    expect(tokens[0].value).toBe("hello\nworld");
  });

  it("should tokenize logical operators", () => {
    const tokens = new Lexer("a && b || c").tokenize();
    expect(tokens.map((t) => t.type)).toEqual([
      "Identifier", "AmpAmp", "Identifier", "PipePipe", "Identifier", "EOF",
    ]);
  });

  it("should tokenize comparison operators", () => {
    const tokens = new Lexer("a < b <= c > d >= e").tokenize();
    expect(tokens.map((t) => t.type)).toEqual([
      "Identifier", "Lt", "Identifier", "LtEq", "Identifier",
      "Gt", "Identifier", "GtEq", "Identifier", "EOF",
    ]);
  });

  it("should tokenize arithmetic operators", () => {
    const tokens = new Lexer("a + b - c * d / e % f").tokenize();
    expect(tokens.map((t) => t.type)).toEqual([
      "Identifier", "Plus", "Identifier", "Minus", "Identifier",
      "Star", "Identifier", "Slash", "Identifier", "Percent", "Identifier", "EOF",
    ]);
  });

  it("should tokenize keywords", () => {
    const tokens = new Lexer("let x = 1; return true;").tokenize();
    expect(tokens.map((t) => t.type)).toEqual([
      "Let", "Identifier", "Eq", "Number", "Semicolon",
      "Return", "True", "Semicolon", "EOF",
    ]);
  });

  it("should tokenize function keyword", () => {
    const tokens = new Lexer("function isOwner() { return true; }").tokenize();
    expect(tokens.map((t) => t.type)).toEqual([
      "Function", "Identifier", "LParen", "RParen",
      "LBrace", "Return", "True", "Semicolon", "RBrace", "EOF",
    ]);
  });

  it("should tokenize is and in keywords", () => {
    const tokens = new Lexer("x is string && y in list").tokenize();
    expect(tokens.map((t) => t.type)).toEqual([
      "Identifier", "Is", "Identifier", "AmpAmp",
      "Identifier", "In", "Identifier", "EOF",
    ]);
  });

  it("should tokenize list and map literals", () => {
    const tokens = new Lexer("[1, 2, 3]").tokenize();
    expect(tokens.map((t) => t.type)).toEqual([
      "LBracket", "Number", "Comma", "Number", "Comma", "Number", "RBracket", "EOF",
    ]);
  });

  it("should tokenize ternary operator", () => {
    const tokens = new Lexer("a ? b : c").tokenize();
    expect(tokens.map((t) => t.type)).toEqual([
      "Identifier", "Question", "Identifier", "Colon", "Identifier", "EOF",
    ]);
  });

  it("should tokenize negation", () => {
    const tokens = new Lexer("!a").tokenize();
    expect(tokens.map((t) => t.type)).toEqual(["Bang", "Identifier", "EOF"]);
  });

  it("should skip line comments", () => {
    const tokens = new Lexer("a // comment\n+ b").tokenize();
    expect(tokens.map((t) => t.type)).toEqual([
      "Identifier", "Plus", "Identifier", "EOF",
    ]);
  });

  it("should skip block comments", () => {
    const tokens = new Lexer("a /* comment */ + b").tokenize();
    expect(tokens.map((t) => t.type)).toEqual([
      "Identifier", "Plus", "Identifier", "EOF",
    ]);
  });

  it("should throw on unexpected character", () => {
    expect(() => new Lexer("~").tokenize()).toThrow("Unexpected character");
  });

  it("should throw on unterminated string", () => {
    expect(() => new Lexer("'hello").tokenize()).toThrow("Unterminated string");
  });
});
