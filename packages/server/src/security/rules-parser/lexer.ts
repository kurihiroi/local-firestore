/** トークン種別 */
export type TokenType =
  | "Number"
  | "String"
  | "Identifier"
  | "True"
  | "False"
  | "Null"
  | "Let"
  | "Return"
  | "Function"
  | "Is"
  | "In"
  | "Plus"
  | "Minus"
  | "Star"
  | "Slash"
  | "Percent"
  | "EqEq"
  | "BangEq"
  | "Lt"
  | "LtEq"
  | "Gt"
  | "GtEq"
  | "AmpAmp"
  | "PipePipe"
  | "Bang"
  | "Dot"
  | "Comma"
  | "Colon"
  | "Semicolon"
  | "Question"
  | "LParen"
  | "RParen"
  | "LBracket"
  | "RBracket"
  | "LBrace"
  | "RBrace"
  | "Eq"
  | "EOF";

export interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const KEYWORDS: Record<string, TokenType> = {
  true: "True",
  false: "False",
  null: "Null",
  let: "Let",
  return: "Return",
  function: "Function",
  is: "Is",
  in: "In",
};

export class Lexer {
  private input: string;
  private pos: number;
  private tokens: Token[];

  constructor(input: string) {
    this.input = input;
    this.pos = 0;
    this.tokens = [];
  }

  tokenize(): Token[] {
    while (this.pos < this.input.length) {
      this.skipWhitespace();
      if (this.pos >= this.input.length) break;

      const ch = this.input[this.pos];

      // コメント
      if (ch === "/" && this.pos + 1 < this.input.length) {
        if (this.input[this.pos + 1] === "/") {
          this.skipLineComment();
          continue;
        }
        if (this.input[this.pos + 1] === "*") {
          this.skipBlockComment();
          continue;
        }
      }

      // 数値リテラル
      if (this.isDigit(ch)) {
        this.readNumber();
        continue;
      }

      // 文字列リテラル
      if (ch === '"' || ch === "'") {
        this.readString(ch);
        continue;
      }

      // 識別子・キーワード
      if (this.isIdentStart(ch)) {
        this.readIdentifier();
        continue;
      }

      // 2文字演算子
      if (this.pos + 1 < this.input.length) {
        const two = this.input.slice(this.pos, this.pos + 2);
        const twoCharOp = this.twoCharOperator(two);
        if (twoCharOp) {
          this.tokens.push({ type: twoCharOp, value: two, pos: this.pos });
          this.pos += 2;
          continue;
        }
      }

      // 1文字演算子・区切り子
      const oneCharOp = this.oneCharOperator(ch);
      if (oneCharOp) {
        this.tokens.push({ type: oneCharOp, value: ch, pos: this.pos });
        this.pos++;
        continue;
      }

      throw new Error(`Unexpected character '${ch}' at position ${this.pos}`);
    }

    this.tokens.push({ type: "EOF", value: "", pos: this.pos });
    return this.tokens;
  }

  private skipWhitespace(): void {
    while (this.pos < this.input.length && /\s/.test(this.input[this.pos])) {
      this.pos++;
    }
  }

  private skipLineComment(): void {
    this.pos += 2;
    while (this.pos < this.input.length && this.input[this.pos] !== "\n") {
      this.pos++;
    }
  }

  private skipBlockComment(): void {
    this.pos += 2;
    while (this.pos + 1 < this.input.length) {
      if (this.input[this.pos] === "*" && this.input[this.pos + 1] === "/") {
        this.pos += 2;
        return;
      }
      this.pos++;
    }
    throw new Error("Unterminated block comment");
  }

  private isDigit(ch: string): boolean {
    return ch >= "0" && ch <= "9";
  }

  private isIdentStart(ch: string): boolean {
    return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
  }

  private isIdentPart(ch: string): boolean {
    return this.isIdentStart(ch) || this.isDigit(ch);
  }

  private readNumber(): void {
    const start = this.pos;
    while (this.pos < this.input.length && this.isDigit(this.input[this.pos])) {
      this.pos++;
    }
    // float
    if (
      this.pos < this.input.length &&
      this.input[this.pos] === "." &&
      this.pos + 1 < this.input.length &&
      this.isDigit(this.input[this.pos + 1])
    ) {
      this.pos++;
      while (this.pos < this.input.length && this.isDigit(this.input[this.pos])) {
        this.pos++;
      }
    }
    this.tokens.push({
      type: "Number",
      value: this.input.slice(start, this.pos),
      pos: start,
    });
  }

  private readString(quote: string): void {
    const start = this.pos;
    this.pos++; // skip opening quote
    let value = "";
    while (this.pos < this.input.length && this.input[this.pos] !== quote) {
      if (this.input[this.pos] === "\\") {
        this.pos++;
        if (this.pos >= this.input.length) throw new Error("Unterminated string");
        const escaped = this.input[this.pos];
        switch (escaped) {
          case "n":
            value += "\n";
            break;
          case "t":
            value += "\t";
            break;
          case "r":
            value += "\r";
            break;
          case "\\":
            value += "\\";
            break;
          default:
            value += escaped;
            break;
        }
      } else {
        value += this.input[this.pos];
      }
      this.pos++;
    }
    if (this.pos >= this.input.length) throw new Error("Unterminated string");
    this.pos++; // skip closing quote
    this.tokens.push({ type: "String", value, pos: start });
  }

  private readIdentifier(): void {
    const start = this.pos;
    while (this.pos < this.input.length && this.isIdentPart(this.input[this.pos])) {
      this.pos++;
    }
    const word = this.input.slice(start, this.pos);
    const keywordType = KEYWORDS[word];
    this.tokens.push({
      type: keywordType ?? "Identifier",
      value: word,
      pos: start,
    });
  }

  private twoCharOperator(two: string): TokenType | null {
    switch (two) {
      case "==":
        return "EqEq";
      case "!=":
        return "BangEq";
      case "<=":
        return "LtEq";
      case ">=":
        return "GtEq";
      case "&&":
        return "AmpAmp";
      case "||":
        return "PipePipe";
      default:
        return null;
    }
  }

  private oneCharOperator(ch: string): TokenType | null {
    switch (ch) {
      case "+":
        return "Plus";
      case "-":
        return "Minus";
      case "*":
        return "Star";
      case "/":
        return "Slash";
      case "%":
        return "Percent";
      case "<":
        return "Lt";
      case ">":
        return "Gt";
      case "!":
        return "Bang";
      case ".":
        return "Dot";
      case ",":
        return "Comma";
      case ":":
        return "Colon";
      case ";":
        return "Semicolon";
      case "?":
        return "Question";
      case "(":
        return "LParen";
      case ")":
        return "RParen";
      case "[":
        return "LBracket";
      case "]":
        return "RBracket";
      case "{":
        return "LBrace";
      case "}":
        return "RBrace";
      case "=":
        return "Eq";
      default:
        return null;
    }
  }
}
