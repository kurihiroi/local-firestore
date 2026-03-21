import {
  type RulesValue,
  mkBool,
  mkFloat,
  mkInt,
} from "./types.js";

/**
 * math namespace 関数
 */
export function callMathFunction(
  method: string,
  args: RulesValue[],
): RulesValue {
  switch (method) {
    case "abs": {
      assertArgCount("abs", args, 1);
      const n = assertNumber(args[0], "abs argument");
      if (args[0].typeName === "int") return mkInt(Math.abs(n));
      return mkFloat(Math.abs(n));
    }

    case "ceil": {
      assertArgCount("ceil", args, 1);
      const n = assertNumber(args[0], "ceil argument");
      return mkInt(Math.ceil(n));
    }

    case "floor": {
      assertArgCount("floor", args, 1);
      const n = assertNumber(args[0], "floor argument");
      return mkInt(Math.floor(n));
    }

    case "round": {
      assertArgCount("round", args, 1);
      const n = assertNumber(args[0], "round argument");
      return mkInt(Math.round(n));
    }

    case "sqrt": {
      assertArgCount("sqrt", args, 1);
      const n = assertNumber(args[0], "sqrt argument");
      return mkFloat(Math.sqrt(n));
    }

    case "pow": {
      assertArgCount("pow", args, 2);
      const base = assertNumber(args[0], "pow base");
      const exp = assertNumber(args[1], "pow exponent");
      const result = Math.pow(base, exp);
      if (args[0].typeName === "int" && args[1].typeName === "int" && Number.isInteger(result)) {
        return mkInt(result);
      }
      return mkFloat(result);
    }

    case "isNaN": {
      assertArgCount("isNaN", args, 1);
      const n = assertNumber(args[0], "isNaN argument");
      return mkBool(Number.isNaN(n));
    }

    case "isInfinite": {
      assertArgCount("isInfinite", args, 1);
      const n = assertNumber(args[0], "isInfinite argument");
      return mkBool(!Number.isFinite(n) && !Number.isNaN(n));
    }

    default:
      throw new Error(`Unknown math function: ${method}`);
  }
}

function assertArgCount(method: string, args: RulesValue[], expected: number): void {
  if (args.length !== expected) {
    throw new Error(`math.${method}() expects ${expected} argument(s), got ${args.length}`);
  }
}

function assertNumber(val: RulesValue, label: string): number {
  if (val.typeName === "int" || val.typeName === "float") return val.value;
  throw new Error(`${label} must be a number, got ${val.typeName}`);
}
