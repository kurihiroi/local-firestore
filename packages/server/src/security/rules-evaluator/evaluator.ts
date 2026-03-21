import type {
  BinaryExpression,
  CallExpression,
  ConditionalExpression,
  Expression,
  FunctionDeclaration,
  IndexExpression,
  IsExpression,
  ListExpression,
  MapExpression,
  MemberExpression,
  UnaryExpression,
} from "../rules-parser/ast.js";
import { Parser } from "../rules-parser/parser.js";
import type { BuiltinFunctionContext } from "./builtin-functions.js";
import { callBytesMethod } from "./bytes-methods.js";
import type { EvaluationContext } from "./context.js";
import { buildGlobalScope } from "./context.js";
import { callDurationMethod, callDurationNamespace } from "./duration-methods.js";
import { callHashingFunction } from "./hashing-functions.js";
import { callLatLngMethod, callLatLngNamespace } from "./latlng-methods.js";
import { callListMethod } from "./list-methods.js";
import { callMapDiffMethod, callMapMethod } from "./map-methods.js";
import { callMathFunction } from "./math-functions.js";
import { evalBinaryOp, evalUnaryOp } from "./operators.js";
import { callSetMethod } from "./set-methods.js";
import { callStringMethod } from "./string-methods.js";
import { callTimestampMethod, callTimestampNamespace } from "./timestamp-methods.js";
import {
  type RulesValue,
  isTypeName,
  mkBool,
  mkFloat,
  mkInt,
  mkList,
  mkMap,
  mkNull,
  mkString,
  toRulesValue,
} from "./types.js";

const MAX_CALL_STACK_DEPTH = 20;

/**
 * AST ベースのルール式評価器
 */
export class RulesEvaluator {
  private builtins: BuiltinFunctionContext;
  private callStackDepth: number = 0;

  constructor(builtins: BuiltinFunctionContext) {
    this.builtins = builtins;
  }

  /**
   * 文字列式を評価してブール値を返す
   */
  evaluateExpression(expr: string, ctx: EvaluationContext): boolean {
    this.builtins.reset();
    this.callStackDepth = 0;

    const parsed = Parser.parseRule(expr);
    const scope = buildGlobalScope(ctx);

    // カスタム関数を登録
    const functions = new Map<string, FunctionDeclaration>();
    for (const fn of parsed.functions) {
      functions.set(fn.name, fn);
    }

    const result = this.eval(parsed.expression, scope, functions);

    if (result.typeName !== "bool") {
      throw new Error(`Rule expression must evaluate to bool, got ${result.typeName}`);
    }
    return result.value;
  }

  /**
   * AST ノードを評価する
   */
  private eval(
    node: Expression,
    scope: Map<string, RulesValue>,
    functions: Map<string, FunctionDeclaration>,
  ): RulesValue {
    switch (node.type) {
      case "BoolLiteral":
        return mkBool(node.value);
      case "IntLiteral":
        return mkInt(node.value);
      case "FloatLiteral":
        return mkFloat(node.value);
      case "StringLiteral":
        return mkString(node.value);
      case "NullLiteral":
        return mkNull();
      case "ListExpression":
        return this.evalList(node, scope, functions);
      case "MapExpression":
        return this.evalMap(node, scope, functions);
      case "Identifier":
        return this.evalIdentifier(node.name, scope);
      case "MemberExpression":
        return this.evalMember(node, scope, functions);
      case "IndexExpression":
        return this.evalIndex(node, scope, functions);
      case "CallExpression":
        return this.evalCall(node, scope, functions);
      case "BinaryExpression":
        return this.evalBinary(node, scope, functions);
      case "UnaryExpression":
        return this.evalUnary(node, scope, functions);
      case "ConditionalExpression":
        return this.evalConditional(node, scope, functions);
      case "IsExpression":
        return this.evalIs(node, scope, functions);
    }
  }

  private evalList(
    node: ListExpression,
    scope: Map<string, RulesValue>,
    functions: Map<string, FunctionDeclaration>,
  ): RulesValue {
    return mkList(node.elements.map((el) => this.eval(el, scope, functions)));
  }

  private evalMap(
    node: MapExpression,
    scope: Map<string, RulesValue>,
    functions: Map<string, FunctionDeclaration>,
  ): RulesValue {
    const map = new Map<string, RulesValue>();
    for (const entry of node.entries) {
      const key = this.eval(entry.key, scope, functions);
      if (key.typeName !== "string") {
        throw new Error("Map key must be a string");
      }
      map.set(key.value, this.eval(entry.value, scope, functions));
    }
    return mkMap(map);
  }

  private evalIdentifier(name: string, scope: Map<string, RulesValue>): RulesValue {
    const val = scope.get(name);
    if (val !== undefined) return val;

    // namespace 識別子はメンバーアクセスで処理されるため、
    // ここでは未定義変数エラー
    throw new Error(`Undefined variable: ${name}`);
  }

  private evalMember(
    node: MemberExpression,
    scope: Map<string, RulesValue>,
    functions: Map<string, FunctionDeclaration>,
  ): RulesValue {
    // namespace アクセスを特別扱い（math.abs 等）
    if (node.object.type === "Identifier") {
      const nsName = node.object.name;
      if (nsName === "math" || nsName === "timestamp" || nsName === "duration" || nsName === "latlng" || nsName === "hashing") {
        // namespace.property はメソッド呼び出しとして CallExpression で処理されるべき
        // ここではプロパティアクセスとして識別子を保持する
        // (実際の呼び出しは evalCall で処理)
        // namespace 自体が scope にあればそれを使う
        if (!scope.has(nsName)) {
          // namespace オブジェクトをダミーとして返す
          // CallExpression が後で呼び出す
          return mkString(`__namespace__:${nsName}.${node.property}`);
        }
      }
    }

    const obj = this.eval(node.object, scope, functions);

    // null チェック
    if (obj.typeName === "null") {
      return mkNull();
    }

    // Map のプロパティアクセス
    if (obj.typeName === "map") {
      const val = obj.value.get(node.property);
      if (val !== undefined) return val;
      throw new Error(`Property '${node.property}' not found in map`);
    }

    throw new Error(`Cannot access property '${node.property}' on ${obj.typeName}`);
  }

  private evalIndex(
    node: IndexExpression,
    scope: Map<string, RulesValue>,
    functions: Map<string, FunctionDeclaration>,
  ): RulesValue {
    const obj = this.eval(node.object, scope, functions);
    const index = this.eval(node.index, scope, functions);

    if (obj.typeName === "list") {
      if (index.typeName !== "int") throw new Error("List index must be int");
      const i = index.value;
      if (i < 0 || i >= obj.value.length) throw new Error(`List index out of bounds: ${i}`);
      return obj.value[i];
    }

    if (obj.typeName === "map") {
      if (index.typeName !== "string") throw new Error("Map key must be string");
      const val = obj.value.get(index.value);
      if (val === undefined) throw new Error(`Key '${index.value}' not found`);
      return val;
    }

    throw new Error(`Cannot index into ${obj.typeName}`);
  }

  private evalCall(
    node: CallExpression,
    scope: Map<string, RulesValue>,
    functions: Map<string, FunctionDeclaration>,
  ): RulesValue {
    const args = node.arguments.map((arg) => this.eval(arg, scope, functions));

    // 名前空間関数呼び出し: math.abs(), timestamp.date() 等
    if (node.callee.type === "MemberExpression" && node.callee.object.type === "Identifier") {
      const nsName = node.callee.object.name;
      const methodName = node.callee.property;

      // namespace 関数
      switch (nsName) {
        case "math":
          return callMathFunction(methodName, args);
        case "hashing":
          return callHashingFunction(methodName, args);
        case "timestamp":
          return callTimestampNamespace(methodName, args);
        case "duration":
          return callDurationNamespace(methodName, args);
        case "latlng":
          return callLatLngNamespace(methodName, args);
      }

      // オブジェクトのメソッド呼び出し
      const obj = this.eval(node.callee.object, scope, functions);
      return this.callMethod(obj, methodName, args);
    }

    // メンバーメソッド呼び出し（チェーン）: a.b.c.method()
    if (node.callee.type === "MemberExpression") {
      const obj = this.eval(node.callee.object, scope, functions);
      return this.callMethod(obj, node.callee.property, args);
    }

    // グローバル関数呼び出し
    if (node.callee.type === "Identifier") {
      const funcName = node.callee.name;

      // 組み込み関数
      switch (funcName) {
        case "get":
          return this.builtins.get(args);
        case "exists":
          return this.builtins.exists(args);
        case "debug":
          return this.builtins.debug(args);
        case "int": {
          if (args.length !== 1) throw new Error("int() expects 1 argument");
          return castToInt(args[0]);
        }
        case "float": {
          if (args.length !== 1) throw new Error("float() expects 1 argument");
          return castToFloat(args[0]);
        }
        case "string": {
          if (args.length !== 1) throw new Error("string() expects 1 argument");
          return castToString(args[0]);
        }
        case "path": {
          if (args.length !== 1) throw new Error("path() expects 1 argument");
          if (args[0].typeName !== "string") throw new Error("path() argument must be string");
          return { typeName: "path", value: args[0].value };
        }
        case "bool": {
          if (args.length !== 1) throw new Error("bool() expects 1 argument");
          if (args[0].typeName !== "bool") throw new Error("bool() argument must be bool");
          return args[0];
        }
      }

      // カスタム関数
      const fn = functions.get(funcName);
      if (fn) {
        return this.callCustomFunction(fn, args, scope, functions);
      }

      throw new Error(`Unknown function: ${funcName}`);
    }

    throw new Error("Invalid call expression");
  }

  private callMethod(obj: RulesValue, method: string, args: RulesValue[]): RulesValue {
    switch (obj.typeName) {
      case "string":
        return callStringMethod(obj.value, method, args);
      case "list":
        return callListMethod(obj.value, method, args);
      case "map":
        return callMapMethod(obj.value, method, args);
      case "set":
        return callSetMethod(obj.value, obj.elements, method, args);
      case "timestamp":
        return callTimestampMethod(obj.value, method, args);
      case "duration":
        return callDurationMethod(obj.nanos, method, args);
      case "latlng":
        return callLatLngMethod(obj, method, args);
      case "bytes":
        return callBytesMethod(obj.value, method, args);
      case "map_diff":
        return callMapDiffMethod(obj, method, args);
      case "path":
        if (method === "bind") {
          // path.bind() はパスのワイルドカードを解決するが、
          // ローカルでは単純にパス文字列を返す
          return obj;
        }
        throw new Error(`Unknown path method: ${method}`);
      default:
        throw new Error(`Cannot call method '${method}' on ${obj.typeName}`);
    }
  }

  private callCustomFunction(
    fn: FunctionDeclaration,
    args: RulesValue[],
    parentScope: Map<string, RulesValue>,
    functions: Map<string, FunctionDeclaration>,
  ): RulesValue {
    if (args.length !== fn.params.length) {
      throw new Error(`Function ${fn.name} expects ${fn.params.length} arguments, got ${args.length}`);
    }

    this.callStackDepth++;
    if (this.callStackDepth > MAX_CALL_STACK_DEPTH) {
      throw new Error(`Maximum call stack depth exceeded (${MAX_CALL_STACK_DEPTH})`);
    }

    try {
      // 新しいスコープを作成（親スコープをコピー）
      const localScope = new Map(parentScope);

      // 引数をバインド
      for (let i = 0; i < fn.params.length; i++) {
        localScope.set(fn.params[i], args[i]);
      }

      // let 束縛を評価
      for (const binding of fn.bindings) {
        localScope.set(binding.name, this.eval(binding.value, localScope, functions));
      }

      // 本体を評価
      return this.eval(fn.body, localScope, functions);
    } finally {
      this.callStackDepth--;
    }
  }

  private evalBinary(
    node: BinaryExpression,
    scope: Map<string, RulesValue>,
    functions: Map<string, FunctionDeclaration>,
  ): RulesValue {
    // 短絡評価
    if (node.operator === "&&") {
      const left = this.eval(node.left, scope, functions);
      if (left.typeName !== "bool") throw new Error(`Cannot apply '&&' to type ${left.typeName}`);
      if (!left.value) return mkBool(false);
      return this.eval(node.right, scope, functions);
    }

    if (node.operator === "||") {
      const left = this.eval(node.left, scope, functions);
      if (left.typeName !== "bool") throw new Error(`Cannot apply '||' to type ${left.typeName}`);
      if (left.value) return mkBool(true);
      return this.eval(node.right, scope, functions);
    }

    const left = this.eval(node.left, scope, functions);
    const right = this.eval(node.right, scope, functions);
    return evalBinaryOp(node.operator, left, right);
  }

  private evalUnary(
    node: UnaryExpression,
    scope: Map<string, RulesValue>,
    functions: Map<string, FunctionDeclaration>,
  ): RulesValue {
    const operand = this.eval(node.operand, scope, functions);
    return evalUnaryOp(node.operator, operand);
  }

  private evalConditional(
    node: ConditionalExpression,
    scope: Map<string, RulesValue>,
    functions: Map<string, FunctionDeclaration>,
  ): RulesValue {
    const test = this.eval(node.test, scope, functions);
    if (test.typeName !== "bool") throw new Error("Ternary condition must be bool");
    return test.value
      ? this.eval(node.consequent, scope, functions)
      : this.eval(node.alternate, scope, functions);
  }

  private evalIs(
    node: IsExpression,
    scope: Map<string, RulesValue>,
    functions: Map<string, FunctionDeclaration>,
  ): RulesValue {
    const value = this.eval(node.value, scope, functions);
    return mkBool(isTypeName(value, node.targetType));
  }
}

function castToInt(val: RulesValue): RulesValue {
  if (val.typeName === "int") return val;
  if (val.typeName === "float") return mkInt(Math.trunc(val.value));
  if (val.typeName === "string") {
    const n = parseInt(val.value, 10);
    if (Number.isNaN(n)) throw new Error(`Cannot convert '${val.value}' to int`);
    return mkInt(n);
  }
  if (val.typeName === "bool") return mkInt(val.value ? 1 : 0);
  throw new Error(`Cannot convert ${val.typeName} to int`);
}

function castToFloat(val: RulesValue): RulesValue {
  if (val.typeName === "float") return val;
  if (val.typeName === "int") return mkFloat(val.value);
  if (val.typeName === "string") {
    const n = parseFloat(val.value);
    if (Number.isNaN(n)) throw new Error(`Cannot convert '${val.value}' to float`);
    return mkFloat(n);
  }
  throw new Error(`Cannot convert ${val.typeName} to float`);
}

function castToString(val: RulesValue): RulesValue {
  if (val.typeName === "string") return val;
  if (val.typeName === "int" || val.typeName === "float") return mkString(String(val.value));
  if (val.typeName === "bool") return mkString(String(val.value));
  if (val.typeName === "null") return mkString("null");
  throw new Error(`Cannot convert ${val.typeName} to string`);
}
