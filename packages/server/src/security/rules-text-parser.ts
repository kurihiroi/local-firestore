import type { CollectionRule, CollectionRules, SecurityRules } from "./rules-engine.js";

/**
 * 本家 `firestore.rules` テキスト形式のパーサー
 *
 * `rules_version` / `service cloud.firestore` / `match` / `allow` / `function`
 * のトップレベル構文を解析し、既存エンジンの `SecurityRules` ツリーへ変換する。
 * allow の条件式・関数本体は式文字列として保持され、評価は既存の
 * ルール式パーサー / 評価器がそのまま行う。
 *
 * 変換規則:
 * - `match /databases/{database}/documents { ... }` ラッパーは剥がし、
 *   ワイルドカード（database）は "(default)" のグローバル束縛になる
 * - `match /users/{userId}` → `rules["users"]`（userId は documentWildcard
 *   として評価時に documentId が束縛される）
 * - `match /users/{userId}/posts/{postId}` →
 *   `rules["users"].subcollections["{userId}"].subcollections["posts"]`
 * - 最終セグメントが `{name=**}` の場合、先行セグメントのノードと
 *   `{name=**}` 子ノードの両方に ops を付与する（直下ドキュメントと
 *   深いパスの両方をカバーするため）
 * - 最終セグメントが固定 ID（`match /config/settings` 等）の場合は
 *   `documentId == '...'` を条件に AND する
 * - 同一ノード・同一オペレーションへの複数 allow は OR 結合
 *   （本家の「いずれかの allow が許可すれば許可」）
 * - `function` 宣言はスコープに関わらずグローバル関数として収集される
 *   （同名関数はスコープを跨いで衝突するため注意）
 *
 * `rules_version` 宣言は受理するが値は無視する（常に v2 セマンティクス）。
 */

/** allow に指定できるオペレーション */
const ALLOW_OPERATIONS = new Set(["read", "write", "get", "list", "create", "update", "delete"]);

type AllowOperation = "read" | "write" | "get" | "list" | "create" | "update" | "delete";

interface AllowStatement {
  ops: AllowOperation[];
  /** 条件式のテキスト（`allow read;` は "true"） */
  expr: string;
}

interface MatchNode {
  segments: string[];
  allows: AllowStatement[];
  functions: string[];
  children: MatchNode[];
}

/** 内容が firestore.rules テキスト形式（JSON ではない）かどうかを判定する */
export function looksLikeRulesText(source: string): boolean {
  const scanner = new Scanner(source);
  scanner.skipTrivia();
  const word = scanner.peekWord();
  return word === "rules_version" || word === "service" || word === "match";
}

/** firestore.rules テキストをパースして SecurityRules へ変換する */
export function parseRulesText(source: string): SecurityRules {
  const scanner = new Scanner(source);
  const serviceFunctions: string[] = [];
  const topMatches: MatchNode[] = [];

  scanner.skipTrivia();
  while (!scanner.eof()) {
    const word = scanner.peekWord();
    if (word === "rules_version") {
      scanner.readWord();
      scanner.expect("=");
      scanner.readStringLiteral(); // 値は無視（常に v2 セマンティクス）
      scanner.expect(";");
    } else if (word === "service") {
      scanner.readWord();
      // サービス名（cloud.firestore）を読み飛ばす
      scanner.readUntil("{").trim();
      scanner.expect("{");
      parseBlock(scanner, topMatches, serviceFunctions, null);
    } else if (word === "match") {
      // service ラッパーなしの match も受理する（テスト・簡易用途）
      topMatches.push(parseMatch(scanner));
    } else {
      throw scanner.error(`Unexpected token "${word ?? scanner.peekChar()}"`);
    }
    scanner.skipTrivia();
  }

  return convert(topMatches, serviceFunctions);
}

/** service / match ブロックの中身をパースする */
function parseBlock(
  scanner: Scanner,
  matches: MatchNode[],
  functions: string[],
  allows: AllowStatement[] | null,
): void {
  scanner.skipTrivia();
  while (!scanner.eof() && scanner.peekChar() !== "}") {
    const word = scanner.peekWord();
    if (word === "match") {
      matches.push(parseMatch(scanner));
    } else if (word === "function") {
      functions.push(scanner.readBalancedFrom());
    } else if (word === "allow") {
      if (allows === null) {
        throw scanner.error("allow statements are not permitted outside a match block");
      }
      allows.push(parseAllow(scanner));
    } else {
      throw scanner.error(`Unexpected token "${word ?? scanner.peekChar()}" in block`);
    }
    scanner.skipTrivia();
  }
  scanner.expect("}");
}

function parseMatch(scanner: Scanner): MatchNode {
  scanner.readWord(); // "match"
  const rawPath = scanner.readMatchPath();
  if (!rawPath.startsWith("/")) {
    throw scanner.error(`Match path must start with "/": "${rawPath}"`);
  }
  const segments = rawPath
    .split("/")
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0);
  if (segments.length === 0) {
    throw scanner.error("Match path must contain at least one segment");
  }
  scanner.expect("{");

  const node: MatchNode = { segments, allows: [], functions: [], children: [] };
  parseBlock(scanner, node.children, node.functions, node.allows);
  return node;
}

function parseAllow(scanner: Scanner): AllowStatement {
  scanner.readWord(); // "allow"
  const ops: AllowOperation[] = [];
  for (;;) {
    scanner.skipTrivia();
    const op = scanner.readWord();
    if (op === undefined || !ALLOW_OPERATIONS.has(op)) {
      throw scanner.error(`Invalid allow operation: "${op}"`);
    }
    ops.push(op as AllowOperation);
    scanner.skipTrivia();
    if (scanner.peekChar() === ",") {
      scanner.expect(",");
      continue;
    }
    break;
  }

  scanner.skipTrivia();
  if (scanner.peekChar() === ";") {
    scanner.expect(";");
    // `allow read;` は無条件許可
    return { ops, expr: "true" };
  }

  scanner.expect(":");
  scanner.skipTrivia();
  const ifWord = scanner.readWord();
  if (ifWord !== "if") {
    throw scanner.error(`Expected "if" after ":", got "${ifWord}"`);
  }
  const expr = scanner.readUntilTopLevel(";").trim();
  scanner.expect(";");
  if (expr.length === 0) {
    throw scanner.error("Empty allow condition");
  }
  return { ops, expr };
}

// ──────────────────────────────────────────────
// SecurityRules ツリーへの変換
// ──────────────────────────────────────────────

interface ParsedWildcard {
  name: string;
  recursive: boolean;
}

function parseWildcard(segment: string): ParsedWildcard | null {
  const match = /^\{(\w+)(=\*\*)?\}$/.exec(segment);
  if (!match) return null;
  return { name: match[1], recursive: match[2] !== undefined };
}

function convert(topMatches: MatchNode[], serviceFunctions: string[]): SecurityRules {
  const rules: CollectionRules = {};
  const functions: string[] = [...serviceFunctions];
  const globalBindings: Record<string, string> = {};

  for (const m of topMatches) {
    // `/databases/{database}/documents` ラッパーを剥がす
    if (m.segments.length === 3 && m.segments[0] === "databases" && m.segments[2] === "documents") {
      const wildcard = parseWildcard(m.segments[1]);
      if (wildcard) {
        globalBindings[wildcard.name] = "(default)";
      }
      if (m.allows.length > 0) {
        throw new Error("allow statements are not permitted directly under the documents root");
      }
      functions.push(...m.functions);
      for (const child of m.children) {
        addMatch(rules, [], child, functions);
      }
      continue;
    }
    addMatch(rules, [], m, functions);
  }

  const result: SecurityRules = { rules };
  if (functions.length > 0) result.functions = functions.join(" ");
  if (Object.keys(globalBindings).length > 0) result.globalBindings = globalBindings;
  return result;
}

function addMatch(
  rules: CollectionRules,
  baseSegments: string[],
  node: MatchNode,
  functions: string[],
): void {
  const fullSegments = [...baseSegments, ...node.segments];
  functions.push(...node.functions);

  if (node.allows.length > 0) {
    const last = fullSegments[fullSegments.length - 1];
    const wildcard = parseWildcard(last);

    if (wildcard && !wildcard.recursive) {
      // match /users/{userId}: ops は親コレクションのノードへ、userId は documentWildcard
      const collectionPath = fullSegments.slice(0, -1);
      if (collectionPath.length === 0) {
        throw new Error(
          `Invalid match path /${fullSegments.join("/")}: documents always live in a collection`,
        );
      }
      const target = ensureNode(rules, collectionPath);
      applyAllows(target, node.allows);
      target.documentWildcard ??= wildcard.name;
    } else if (wildcard?.recursive) {
      // match /.../{name=**}: 深いパス用の {name=**} 子ノードと、
      // 直下ドキュメント用の先行ノードの両方に ops を付与する
      const starNode = ensureNode(rules, fullSegments);
      applyAllows(starNode, node.allows);
      starNode.documentWildcard ??= wildcard.name;

      const parentPath = fullSegments.slice(0, -1);
      if (parentPath.length > 0) {
        const parentNode = ensureNode(rules, parentPath);
        applyAllows(parentNode, node.allows);
        parentNode.documentWildcard ??= wildcard.name;
      }
    } else {
      // match /config/settings: 固定ドキュメント ID は documentId 条件に変換する
      if (fullSegments.length < 2) {
        throw new Error(
          `Invalid match path /${fullSegments.join("/")}: documents always live in a collection`,
        );
      }
      const target = ensureNode(rules, fullSegments.slice(0, -1));
      applyAllows(target, node.allows, `documentId == '${last.replace(/'/g, "\\'")}'`);
    }
  }

  for (const child of node.children) {
    addMatch(rules, fullSegments, child, functions);
  }
}

/** セグメント列に対応するノードを取得する（なければ作成） */
function ensureNode(rules: CollectionRules, segments: string[]): CollectionRule {
  let current = rules;
  let node: CollectionRule | undefined;
  for (let i = 0; i < segments.length; i++) {
    const key = segments[i];
    if (!current[key]) {
      current[key] = {};
    }
    node = current[key];
    if (i < segments.length - 1) {
      node.subcollections ??= {};
      current = node.subcollections;
    }
  }
  if (!node) throw new Error("ensureNode requires at least one segment");
  return node;
}

/** allow 群をノードのオペレーションへマージする（複数 allow は OR 結合） */
function applyAllows(node: CollectionRule, allows: AllowStatement[], guard?: string): void {
  for (const allow of allows) {
    const conditioned =
      guard !== undefined
        ? allow.expr === "true"
          ? guard
          : `(${guard}) && (${allow.expr})`
        : allow.expr;
    for (const op of allow.ops) {
      const existing = node[op];
      if (existing === true) continue; // 既に無条件許可
      if (conditioned === "true") {
        node[op] = true;
        continue;
      }
      node[op] =
        existing === undefined || existing === false
          ? conditioned
          : `(${existing}) || (${conditioned})`;
    }
  }
}

// ──────────────────────────────────────────────
// 字句スキャナ（構造のみ。式テキストは切り出して既存パーサーに委譲）
// ──────────────────────────────────────────────

class Scanner {
  pos = 0;

  constructor(private src: string) {}

  eof(): boolean {
    this.skipTrivia();
    return this.pos >= this.src.length;
  }

  /** 空白と // / /* コメントを読み飛ばす */
  skipTrivia(): void {
    for (;;) {
      while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) {
        this.pos++;
      }
      if (this.src.startsWith("//", this.pos)) {
        const nl = this.src.indexOf("\n", this.pos);
        this.pos = nl === -1 ? this.src.length : nl + 1;
        continue;
      }
      if (this.src.startsWith("/*", this.pos)) {
        const end = this.src.indexOf("*/", this.pos + 2);
        if (end === -1) throw this.error("Unterminated block comment");
        this.pos = end + 2;
        continue;
      }
      return;
    }
  }

  peekChar(): string {
    this.skipTrivia();
    return this.src[this.pos] ?? "";
  }

  peekWord(): string | undefined {
    this.skipTrivia();
    const match = /^[A-Za-z_]\w*/.exec(this.src.slice(this.pos));
    return match?.[0];
  }

  readWord(): string | undefined {
    const word = this.peekWord();
    if (word !== undefined) this.pos += word.length;
    return word;
  }

  expect(ch: string): void {
    this.skipTrivia();
    if (!this.src.startsWith(ch, this.pos)) {
      throw this.error(`Expected "${ch}"`);
    }
    this.pos += ch.length;
  }

  /** 文字列リテラル（'...' または "..."）を読む */
  readStringLiteral(): string {
    this.skipTrivia();
    const quote = this.src[this.pos];
    if (quote !== "'" && quote !== '"') {
      throw this.error("Expected string literal");
    }
    let i = this.pos + 1;
    let value = "";
    while (i < this.src.length && this.src[i] !== quote) {
      if (this.src[i] === "\\") i++;
      value += this.src[i];
      i++;
    }
    if (i >= this.src.length) throw this.error("Unterminated string literal");
    this.pos = i + 1;
    return value;
  }

  /**
   * match のパス（/users/{userId} など）を読む。
   * `/` の直後の `{` はワイルドカード、それ以外の `{` はブロック開始として停止する。
   */
  readMatchPath(): string {
    this.skipTrivia();
    let path = "";
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === "{") {
        if (!path.endsWith("/")) break; // ブロック開始
        const close = this.src.indexOf("}", this.pos);
        if (close === -1) throw this.error("Unterminated wildcard in match path");
        path += this.src.slice(this.pos, close + 1);
        this.pos = close + 1;
        continue;
      }
      if (/\s/.test(ch)) break;
      path += ch;
      this.pos++;
    }
    return path;
  }

  /** 指定文字の直前まで読み進めて返す（文字は消費しない） */
  readUntil(ch: string): string {
    const idx = this.src.indexOf(ch, this.pos);
    if (idx === -1) throw this.error(`Expected "${ch}"`);
    const text = this.src.slice(this.pos, idx);
    this.pos = idx;
    return text;
  }

  /**
   * 文字列リテラルと括弧のネストを考慮しつつ、トップレベルの terminator の
   * 直前まで読み進めて返す（terminator は消費しない）。
   * allow 条件式の切り出しに使う（式中の文字列に ';' が含まれても壊れない）。
   */
  readUntilTopLevel(terminator: string): string {
    const start = this.pos;
    let depth = 0;
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === "'" || ch === '"') {
        this.skipStringLiteral();
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;
      else if (ch === terminator && depth === 0) {
        return this.src.slice(start, this.pos);
      }
      this.pos++;
    }
    throw this.error(`Expected "${terminator}"`);
  }

  /**
   * 現在位置（function キーワード）から対応する閉じ '}' までを
   * テキストとして読み取る（関数宣言の切り出し用）。
   */
  readBalancedFrom(): string {
    const start = this.pos;
    // '{' まで進める
    while (this.pos < this.src.length && this.src[this.pos] !== "{") {
      const ch = this.src[this.pos];
      if (ch === "'" || ch === '"') {
        this.skipStringLiteral();
        continue;
      }
      this.pos++;
    }
    if (this.pos >= this.src.length) throw this.error("Expected function body");
    let depth = 0;
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === "'" || ch === '"') {
        this.skipStringLiteral();
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          this.pos++;
          return this.src.slice(start, this.pos);
        }
      }
      this.pos++;
    }
    throw this.error("Unterminated function body");
  }

  private skipStringLiteral(): void {
    const quote = this.src[this.pos];
    this.pos++;
    while (this.pos < this.src.length && this.src[this.pos] !== quote) {
      if (this.src[this.pos] === "\\") this.pos++;
      this.pos++;
    }
    if (this.pos >= this.src.length) throw this.error("Unterminated string literal");
    this.pos++; // closing quote
  }

  error(message: string): Error {
    const line = this.src.slice(0, this.pos).split("\n").length;
    return new Error(`Failed to parse firestore.rules (line ${line}): ${message}`);
  }
}
