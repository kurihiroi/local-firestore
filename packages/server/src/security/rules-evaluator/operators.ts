import type { BinaryOperator, UnaryOperator } from "../rules-parser/ast.js";
import {
  containsUnknown,
  isUnknown,
  mkBool,
  mkFloat,
  mkInt,
  mkList,
  mkString,
  mkUnknown,
  type RulesValue,
  rulesValueEquals,
  rulesValueToString,
  toNumber,
} from "./types.js";

/**
 * 二項演算子を評価する
 */
export function evalBinaryOp(op: BinaryOperator, left: RulesValue, right: RulesValue): RulesValue {
  // unknown の伝播（list ルールの静的証明）:
  // && / || は Kleene の三値論理（evalLogicalAnd / Or 内で処理）、
  // ==/!= は深い unknown 含有もチェック、その他の演算は unknown へ倒す
  if (op !== "&&" && op !== "||") {
    if (op === "==" || op === "!=") {
      if (containsUnknown(left) || containsUnknown(right)) return mkUnknown();
    } else if (op === "in") {
      // evalIn 内で部分マップ・unknown を個別に処理する
    } else if (isUnknown(left) || isUnknown(right)) {
      return mkUnknown();
    }
  }

  switch (op) {
    case "&&":
      return evalLogicalAnd(left, right);
    case "||":
      return evalLogicalOr(left, right);
    case "==":
      return mkBool(rulesValueEquals(left, right));
    case "!=":
      return mkBool(!rulesValueEquals(left, right));
    case "<":
    case "<=":
    case ">":
    case ">=":
      return evalComparison(op, left, right);
    case "+":
      return evalAdd(left, right);
    case "-":
      return evalSubtract(left, right);
    case "*":
      return evalMultiply(left, right);
    case "/":
      return evalDivide(left, right);
    case "%":
      return evalModulo(left, right);
    case "in":
      return evalIn(left, right);
  }
}

/**
 * 単項演算子を評価する
 */
export function evalUnaryOp(op: UnaryOperator, operand: RulesValue): RulesValue {
  if (isUnknown(operand)) return mkUnknown();
  switch (op) {
    case "!":
      if (operand.typeName !== "bool") {
        throw new Error(`Cannot apply '!' to type ${operand.typeName}`);
      }
      return mkBool(!operand.value);
    case "-":
      if (operand.typeName === "int") return mkInt(-operand.value);
      if (operand.typeName === "float") return mkFloat(-operand.value);
      throw new Error(`Cannot negate type ${operand.typeName}`);
  }
}

/** Kleene の三値論理 AND: false が支配的、true 同士のみ true、他は unknown */
function evalLogicalAnd(left: RulesValue, right: RulesValue): RulesValue {
  if (left.typeName === "bool" && !left.value) return mkBool(false);
  if (right.typeName === "bool" && !right.value) return mkBool(false);
  if (isUnknown(left) || isUnknown(right)) return mkUnknown();
  if (left.typeName !== "bool") throw new Error(`Cannot apply '&&' to type ${left.typeName}`);
  if (right.typeName !== "bool") throw new Error(`Cannot apply '&&' to type ${right.typeName}`);
  return mkBool(left.value && right.value);
}

/** Kleene の三値論理 OR: true が支配的、false 同士のみ false、他は unknown */
function evalLogicalOr(left: RulesValue, right: RulesValue): RulesValue {
  if (left.typeName === "bool" && left.value) return mkBool(true);
  if (right.typeName === "bool" && right.value) return mkBool(true);
  if (isUnknown(left) || isUnknown(right)) return mkUnknown();
  if (left.typeName !== "bool") throw new Error(`Cannot apply '||' to type ${left.typeName}`);
  if (right.typeName !== "bool") throw new Error(`Cannot apply '||' to type ${right.typeName}`);
  return mkBool(left.value || right.value);
}

function evalComparison(
  op: "<" | "<=" | ">" | ">=",
  left: RulesValue,
  right: RulesValue,
): RulesValue {
  // 数値比較
  const ln = toNumber(left);
  const rn = toNumber(right);
  if (ln !== null && rn !== null) {
    switch (op) {
      case "<":
        return mkBool(ln < rn);
      case "<=":
        return mkBool(ln <= rn);
      case ">":
        return mkBool(ln > rn);
      case ">=":
        return mkBool(ln >= rn);
    }
  }

  // 文字列比較
  if (left.typeName === "string" && right.typeName === "string") {
    switch (op) {
      case "<":
        return mkBool(left.value < right.value);
      case "<=":
        return mkBool(left.value <= right.value);
      case ">":
        return mkBool(left.value > right.value);
      case ">=":
        return mkBool(left.value >= right.value);
    }
  }

  // Timestamp比較
  if (left.typeName === "timestamp" && right.typeName === "timestamp") {
    const lt = left.value.getTime();
    const rt = right.value.getTime();
    switch (op) {
      case "<":
        return mkBool(lt < rt);
      case "<=":
        return mkBool(lt <= rt);
      case ">":
        return mkBool(lt > rt);
      case ">=":
        return mkBool(lt >= rt);
    }
  }

  // Duration比較
  if (left.typeName === "duration" && right.typeName === "duration") {
    switch (op) {
      case "<":
        return mkBool(left.nanos < right.nanos);
      case "<=":
        return mkBool(left.nanos <= right.nanos);
      case ">":
        return mkBool(left.nanos > right.nanos);
      case ">=":
        return mkBool(left.nanos >= right.nanos);
    }
  }

  throw new Error(`Cannot compare ${left.typeName} ${op} ${right.typeName}`);
}

function evalAdd(left: RulesValue, right: RulesValue): RulesValue {
  // 数値加算
  if (left.typeName === "int" && right.typeName === "int") {
    return mkInt(left.value + right.value);
  }
  if (
    (left.typeName === "int" || left.typeName === "float") &&
    (right.typeName === "int" || right.typeName === "float")
  ) {
    return mkFloat(left.value + right.value);
  }

  // 文字列結合
  if (left.typeName === "string" && right.typeName === "string") {
    return mkString(left.value + right.value);
  }

  // リスト結合
  if (left.typeName === "list" && right.typeName === "list") {
    return mkList([...left.value, ...right.value]);
  }

  // Timestamp + Duration
  if (left.typeName === "timestamp" && right.typeName === "duration") {
    const ms = right.nanos / 1_000_000;
    return { typeName: "timestamp", value: new Date(left.value.getTime() + ms) };
  }

  // Duration + Duration
  if (left.typeName === "duration" && right.typeName === "duration") {
    return { typeName: "duration", nanos: left.nanos + right.nanos };
  }

  throw new Error(`Cannot add ${left.typeName} + ${right.typeName}`);
}

function evalSubtract(left: RulesValue, right: RulesValue): RulesValue {
  if (left.typeName === "int" && right.typeName === "int") {
    return mkInt(left.value - right.value);
  }
  if (
    (left.typeName === "int" || left.typeName === "float") &&
    (right.typeName === "int" || right.typeName === "float")
  ) {
    return mkFloat(left.value - right.value);
  }

  // Timestamp - Duration
  if (left.typeName === "timestamp" && right.typeName === "duration") {
    const ms = right.nanos / 1_000_000;
    return { typeName: "timestamp", value: new Date(left.value.getTime() - ms) };
  }

  // Timestamp - Timestamp → Duration
  if (left.typeName === "timestamp" && right.typeName === "timestamp") {
    const diffMs = left.value.getTime() - right.value.getTime();
    return { typeName: "duration", nanos: diffMs * 1_000_000 };
  }

  // Duration - Duration
  if (left.typeName === "duration" && right.typeName === "duration") {
    return { typeName: "duration", nanos: left.nanos - right.nanos };
  }

  throw new Error(`Cannot subtract ${left.typeName} - ${right.typeName}`);
}

function evalMultiply(left: RulesValue, right: RulesValue): RulesValue {
  if (left.typeName === "int" && right.typeName === "int") {
    return mkInt(left.value * right.value);
  }
  if (
    (left.typeName === "int" || left.typeName === "float") &&
    (right.typeName === "int" || right.typeName === "float")
  ) {
    return mkFloat(left.value * right.value);
  }
  throw new Error(`Cannot multiply ${left.typeName} * ${right.typeName}`);
}

function evalDivide(left: RulesValue, right: RulesValue): RulesValue {
  const rn = toNumber(right);
  if (rn === 0) throw new Error("Division by zero");

  if (left.typeName === "int" && right.typeName === "int") {
    return mkInt(Math.trunc(left.value / right.value));
  }
  if (
    (left.typeName === "int" || left.typeName === "float") &&
    (right.typeName === "int" || right.typeName === "float")
  ) {
    return mkFloat(left.value / right.value);
  }
  throw new Error(`Cannot divide ${left.typeName} / ${right.typeName}`);
}

function evalModulo(left: RulesValue, right: RulesValue): RulesValue {
  if (left.typeName === "int" && right.typeName === "int") {
    if (right.value === 0) throw new Error("Modulo by zero");
    return mkInt(left.value % right.value);
  }
  if (
    (left.typeName === "int" || left.typeName === "float") &&
    (right.typeName === "int" || right.typeName === "float")
  ) {
    if (right.value === 0) throw new Error("Modulo by zero");
    return mkFloat(left.value % right.value);
  }
  throw new Error(`Cannot modulo ${left.typeName} % ${right.typeName}`);
}

function evalIn(left: RulesValue, right: RulesValue): RulesValue {
  if (isUnknown(right)) return mkUnknown();

  // value in list
  if (right.typeName === "list") {
    if (containsUnknown(left)) return mkUnknown();
    if (right.value.some((item) => rulesValueEquals(left, item))) return mkBool(true);
    // 一致なし: リスト側に unknown 要素があれば「含まれない」とは証明できない
    return right.value.some(containsUnknown) ? mkUnknown() : mkBool(false);
  }

  // key in map
  if (right.typeName === "map") {
    if (isUnknown(left)) return mkUnknown();
    if (left.typeName !== "string") throw new Error("Map key must be string for 'in' operator");
    if (right.value.has(left.value)) return mkBool(true);
    // 部分マップは見えていないキーがあり得るため、不在は証明できない
    return right.partial ? mkUnknown() : mkBool(false);
  }

  // value in set
  if (right.typeName === "set") {
    if (containsUnknown(left) || right.elements.some(containsUnknown)) return mkUnknown();
    return mkBool(right.value.has(rulesValueToString(left)));
  }

  throw new Error(`Cannot use 'in' with ${right.typeName}`);
}
