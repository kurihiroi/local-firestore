import type {
  BinaryOperator,
  Expression,
  FunctionDeclaration,
  LetBinding,
  RuleExpression,
  UnaryOperator,
} from "./ast.js";
import type { Token, TokenType } from "./lexer.js";
import { Lexer } from "./lexer.js";

/**
 * 再帰下降パーサー
 *
 * 演算子優先順位（低→高）:
 * 1. ?: (三項)
 * 2. || (論理OR)
 * 3. && (論理AND)
 * 4. ==, != (等値)
 * 5. <, <=, >, >=, in, is (比較)
 * 6. +, - (加減算)
 * 7. *, /, % (乗除算)
 * 8. !, - (単項)
 * 9. ., (), [] (メンバー・呼び出し・添字)
 */
export class Parser {
  private tokens: Token[];
  private pos: number;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.pos = 0;
  }

  static parseExpression(input: string): Expression {
    const lexer = new Lexer(input);
    const tokens = lexer.tokenize();
    const parser = new Parser(tokens);
    const expr = parser.parseExpr();
    if (parser.current().type !== "EOF") {
      throw new Error(`Unexpected token '${parser.current().value}' at position ${parser.current().pos}`);
    }
    return expr;
  }

  static parseRule(input: string): RuleExpression {
    const lexer = new Lexer(input);
    const tokens = lexer.tokenize();
    const parser = new Parser(tokens);

    const functions: FunctionDeclaration[] = [];
    while (parser.current().type === "Function") {
      functions.push(parser.parseFunctionDeclaration());
    }

    const expression = parser.parseExpr();
    if (parser.current().type !== "EOF") {
      throw new Error(`Unexpected token '${parser.current().value}' at position ${parser.current().pos}`);
    }
    return { functions, expression };
  }

  private current(): Token {
    return this.tokens[this.pos];
  }

  private peek(offset: number = 1): Token {
    return this.tokens[this.pos + offset] ?? { type: "EOF", value: "", pos: -1 };
  }

  private advance(): Token {
    const token = this.tokens[this.pos];
    this.pos++;
    return token;
  }

  private expect(type: TokenType): Token {
    const token = this.current();
    if (token.type !== type) {
      throw new Error(`Expected ${type} but got ${token.type} ('${token.value}') at position ${token.pos}`);
    }
    return this.advance();
  }

  private match(type: TokenType): boolean {
    if (this.current().type === type) {
      this.advance();
      return true;
    }
    return false;
  }

  private parseFunctionDeclaration(): FunctionDeclaration {
    this.expect("Function");
    const name = this.expect("Identifier").value;
    this.expect("LParen");

    const params: string[] = [];
    if (this.current().type !== "RParen") {
      params.push(this.expect("Identifier").value);
      while (this.match("Comma")) {
        params.push(this.expect("Identifier").value);
      }
    }
    this.expect("RParen");
    this.expect("LBrace");

    const bindings: LetBinding[] = [];
    while (this.current().type === "Let") {
      bindings.push(this.parseLetBinding());
    }

    this.expect("Return");
    const body = this.parseExpr();
    this.expect("Semicolon");
    this.expect("RBrace");

    return { type: "FunctionDeclaration", name, params, bindings, body };
  }

  private parseLetBinding(): LetBinding {
    this.expect("Let");
    const name = this.expect("Identifier").value;
    this.expect("Eq");
    const value = this.parseExpr();
    this.expect("Semicolon");
    return { type: "LetBinding", name, value };
  }

  // ─── 式パーサー（優先順位順） ───

  private parseExpr(): Expression {
    return this.parseTernary();
  }

  private parseTernary(): Expression {
    let expr = this.parseOr();
    if (this.current().type === "Question") {
      this.advance();
      const consequent = this.parseExpr();
      this.expect("Colon");
      const alternate = this.parseExpr();
      expr = { type: "ConditionalExpression", test: expr, consequent, alternate };
    }
    return expr;
  }

  private parseOr(): Expression {
    let left = this.parseAnd();
    while (this.current().type === "PipePipe") {
      this.advance();
      const right = this.parseAnd();
      left = { type: "BinaryExpression", operator: "||", left, right };
    }
    return left;
  }

  private parseAnd(): Expression {
    let left = this.parseEquality();
    while (this.current().type === "AmpAmp") {
      this.advance();
      const right = this.parseEquality();
      left = { type: "BinaryExpression", operator: "&&", left, right };
    }
    return left;
  }

  private parseEquality(): Expression {
    let left = this.parseComparison();
    while (this.current().type === "EqEq" || this.current().type === "BangEq") {
      const op: BinaryOperator = this.current().type === "EqEq" ? "==" : "!=";
      this.advance();
      const right = this.parseComparison();
      left = { type: "BinaryExpression", operator: op, left, right };
    }
    return left;
  }

  private parseComparison(): Expression {
    let left = this.parseAddition();

    while (true) {
      const t = this.current().type;
      if (t === "Lt" || t === "LtEq" || t === "Gt" || t === "GtEq") {
        const opMap: Record<string, BinaryOperator> = {
          Lt: "<",
          LtEq: "<=",
          Gt: ">",
          GtEq: ">=",
        };
        const op = opMap[t];
        this.advance();
        const right = this.parseAddition();
        left = { type: "BinaryExpression", operator: op, left, right };
      } else if (t === "In") {
        this.advance();
        const right = this.parseAddition();
        left = { type: "BinaryExpression", operator: "in", left, right };
      } else if (t === "Is") {
        this.advance();
        // 型名は Identifier だが、null 等のキーワードも型名として使える
        const token = this.current();
        if (token.type === "Identifier" || token.type === "Null") {
          this.advance();
          left = { type: "IsExpression", value: left, targetType: token.value };
        } else {
          throw new Error(`Expected type name but got ${token.type} ('${token.value}') at position ${token.pos}`);
        }
      } else {
        break;
      }
    }
    return left;
  }

  private parseAddition(): Expression {
    let left = this.parseMultiplication();
    while (this.current().type === "Plus" || this.current().type === "Minus") {
      const op: BinaryOperator = this.current().type === "Plus" ? "+" : "-";
      this.advance();
      const right = this.parseMultiplication();
      left = { type: "BinaryExpression", operator: op, left, right };
    }
    return left;
  }

  private parseMultiplication(): Expression {
    let left = this.parseUnary();
    while (
      this.current().type === "Star" ||
      this.current().type === "Slash" ||
      this.current().type === "Percent"
    ) {
      const opMap: Record<string, BinaryOperator> = {
        Star: "*",
        Slash: "/",
        Percent: "%",
      };
      const op = opMap[this.current().type];
      this.advance();
      const right = this.parseUnary();
      left = { type: "BinaryExpression", operator: op, left, right };
    }
    return left;
  }

  private parseUnary(): Expression {
    if (this.current().type === "Bang") {
      this.advance();
      const operand = this.parseUnary();
      return { type: "UnaryExpression", operator: "!" as UnaryOperator, operand };
    }
    if (this.current().type === "Minus") {
      // 負の単項演算子（数値の前にのみ。識別子の前は二項減算になるが、
      // ここでは単項として扱う）
      this.advance();
      const operand = this.parseUnary();
      return { type: "UnaryExpression", operator: "-" as UnaryOperator, operand };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expression {
    let expr = this.parsePrimary();

    while (true) {
      if (this.current().type === "Dot") {
        this.advance();
        const property = this.expect("Identifier").value;
        // メソッド呼び出し: obj.method(args)
        if (this.current().type === "LParen") {
          this.advance();
          const args = this.parseArgumentList();
          this.expect("RParen");
          expr = {
            type: "CallExpression",
            callee: { type: "MemberExpression", object: expr, property },
            arguments: args,
          };
        } else {
          expr = { type: "MemberExpression", object: expr, property };
        }
      } else if (this.current().type === "LBracket") {
        this.advance();
        const index = this.parseExpr();
        this.expect("RBracket");
        expr = { type: "IndexExpression", object: expr, index };
      } else if (this.current().type === "LParen" && expr.type === "Identifier") {
        // 関数呼び出し: func(args)
        this.advance();
        const args = this.parseArgumentList();
        this.expect("RParen");
        expr = { type: "CallExpression", callee: expr, arguments: args };
      } else {
        break;
      }
    }
    return expr;
  }

  private parseArgumentList(): Expression[] {
    const args: Expression[] = [];
    if (this.current().type !== "RParen") {
      args.push(this.parseExpr());
      while (this.match("Comma")) {
        args.push(this.parseExpr());
      }
    }
    return args;
  }

  private parsePrimary(): Expression {
    const token = this.current();

    switch (token.type) {
      case "True":
        this.advance();
        return { type: "BoolLiteral", value: true };
      case "False":
        this.advance();
        return { type: "BoolLiteral", value: false };
      case "Null":
        this.advance();
        return { type: "NullLiteral" };
      case "Number": {
        this.advance();
        const isFloat = token.value.includes(".");
        return isFloat
          ? { type: "FloatLiteral", value: parseFloat(token.value) }
          : { type: "IntLiteral", value: parseInt(token.value, 10) };
      }
      case "String":
        this.advance();
        return { type: "StringLiteral", value: token.value };
      case "Identifier":
        this.advance();
        return { type: "Identifier", name: token.value };
      case "LParen": {
        this.advance();
        const expr = this.parseExpr();
        this.expect("RParen");
        return expr;
      }
      case "LBracket":
        return this.parseListLiteral();
      case "LBrace":
        return this.parseMapLiteral();
      default:
        throw new Error(
          `Unexpected token ${token.type} ('${token.value}') at position ${token.pos}`,
        );
    }
  }

  private parseListLiteral(): Expression {
    this.expect("LBracket");
    const elements: Expression[] = [];
    if (this.current().type !== "RBracket") {
      elements.push(this.parseExpr());
      while (this.match("Comma")) {
        if (this.current().type === "RBracket") break; // trailing comma
        elements.push(this.parseExpr());
      }
    }
    this.expect("RBracket");
    return { type: "ListExpression", elements };
  }

  private parseMapLiteral(): Expression {
    this.expect("LBrace");
    const entries: Array<{ key: Expression; value: Expression }> = [];
    if (this.current().type !== "RBrace") {
      const key = this.parseExpr();
      this.expect("Colon");
      const value = this.parseExpr();
      entries.push({ key, value });
      while (this.match("Comma")) {
        if (this.current().type === "RBrace") break; // trailing comma
        const k = this.parseExpr();
        this.expect("Colon");
        const v = this.parseExpr();
        entries.push({ key: k, value: v });
      }
    }
    this.expect("RBrace");
    return { type: "MapExpression", entries };
  }
}
