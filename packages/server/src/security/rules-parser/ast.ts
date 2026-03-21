/** AST ノードの基底型 */
export interface BaseNode {
  type: string;
}

// ─── リテラル ───

export interface BoolLiteral extends BaseNode {
  type: "BoolLiteral";
  value: boolean;
}

export interface IntLiteral extends BaseNode {
  type: "IntLiteral";
  value: number;
}

export interface FloatLiteral extends BaseNode {
  type: "FloatLiteral";
  value: number;
}

export interface StringLiteral extends BaseNode {
  type: "StringLiteral";
  value: string;
}

export interface NullLiteral extends BaseNode {
  type: "NullLiteral";
}

export interface ListExpression extends BaseNode {
  type: "ListExpression";
  elements: Expression[];
}

export interface MapExpression extends BaseNode {
  type: "MapExpression";
  entries: Array<{ key: Expression; value: Expression }>;
}

// ─── 識別子・アクセス ───

export interface Identifier extends BaseNode {
  type: "Identifier";
  name: string;
}

export interface MemberExpression extends BaseNode {
  type: "MemberExpression";
  object: Expression;
  property: string;
}

export interface IndexExpression extends BaseNode {
  type: "IndexExpression";
  object: Expression;
  index: Expression;
}

// ─── 関数呼び出し ───

export interface CallExpression extends BaseNode {
  type: "CallExpression";
  callee: Expression;
  arguments: Expression[];
}

// ─── 演算 ───

export type BinaryOperator =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "&&"
  | "||"
  | "in";

export interface BinaryExpression extends BaseNode {
  type: "BinaryExpression";
  operator: BinaryOperator;
  left: Expression;
  right: Expression;
}

export type UnaryOperator = "!" | "-";

export interface UnaryExpression extends BaseNode {
  type: "UnaryExpression";
  operator: UnaryOperator;
  operand: Expression;
}

export interface ConditionalExpression extends BaseNode {
  type: "ConditionalExpression";
  test: Expression;
  consequent: Expression;
  alternate: Expression;
}

export interface IsExpression extends BaseNode {
  type: "IsExpression";
  value: Expression;
  targetType: string;
}

// ─── 関数定義・let束縛 ───

export interface LetBinding extends BaseNode {
  type: "LetBinding";
  name: string;
  value: Expression;
}

export interface ReturnStatement extends BaseNode {
  type: "ReturnStatement";
  value: Expression;
}

export interface FunctionDeclaration extends BaseNode {
  type: "FunctionDeclaration";
  name: string;
  params: string[];
  bindings: LetBinding[];
  body: Expression;
}

// ─── 式の共用体 ───

export type Expression =
  | BoolLiteral
  | IntLiteral
  | FloatLiteral
  | StringLiteral
  | NullLiteral
  | ListExpression
  | MapExpression
  | Identifier
  | MemberExpression
  | IndexExpression
  | CallExpression
  | BinaryExpression
  | UnaryExpression
  | ConditionalExpression
  | IsExpression;

/** 関数定義を含むトップレベルのルール式 */
export interface RuleExpression {
  functions: FunctionDeclaration[];
  expression: Expression;
}
