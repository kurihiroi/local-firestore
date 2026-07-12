import { mkBool, mkBytes, mkInt, mkList, mkString, type RulesValue } from "./types.js";

/**
 * String 型のメソッドをディスパッチする
 */
export function callStringMethod(str: string, method: string, args: RulesValue[]): RulesValue {
  switch (method) {
    case "size":
      return mkInt(str.length);

    case "matches": {
      assertArgCount("matches", args, 1);
      const pattern = assertString(args[0], "matches argument");
      // 本家は RE2 で「文字列全体」のマッチ。アンカーなしパターンでも
      // 部分一致にならないよう ^(?:...)$ で全体一致化する
      const regex = compileRe2Pattern(pattern, `^(?:${pattern})$`);
      return mkBool(regex.test(str));
    }

    case "split": {
      assertArgCount("split", args, 1);
      const separator = assertString(args[0], "split argument");
      const parts = str.split(separator);
      return mkList(parts.map(mkString));
    }

    case "trim":
      assertArgCount("trim", args, 0);
      return mkString(str.trim());

    case "lower":
      assertArgCount("lower", args, 0);
      return mkString(str.toLowerCase());

    case "upper":
      assertArgCount("upper", args, 0);
      return mkString(str.toUpperCase());

    case "replace": {
      assertArgCount("replace", args, 2);
      const pattern = assertString(args[0], "replace pattern");
      const replacement = assertString(args[1], "replace replacement");
      const regex = compileRe2Pattern(pattern, pattern, "g");
      return mkString(str.replace(regex, replacement));
    }

    case "contains": {
      assertArgCount("contains", args, 1);
      const substring = assertString(args[0], "contains argument");
      return mkBool(str.includes(substring));
    }

    case "startsWith": {
      assertArgCount("startsWith", args, 1);
      const prefix = assertString(args[0], "startsWith argument");
      return mkBool(str.startsWith(prefix));
    }

    case "endsWith": {
      assertArgCount("endsWith", args, 1);
      const suffix = assertString(args[0], "endsWith argument");
      return mkBool(str.endsWith(suffix));
    }

    case "toUtf8": {
      assertArgCount("toUtf8", args, 0);
      const encoder = new TextEncoder();
      return mkBytes(encoder.encode(str));
    }

    default:
      throw new Error(`Unknown string method: ${method}`);
  }
}

/**
 * RE2 方言のパターンを JS RegExp へコンパイルする。
 *
 * 本家の matches() / replace() は RE2 で評価される。JS RegExp にはあるが
 * RE2 に存在しない後方参照・ルックアラウンドを含むパターンは、本家では
 * パースエラー（→ 評価エラー → 拒否）になるため、ここでもエラーにして
 * 「ローカルでだけ通る」乖離を防ぐ。
 *
 * @param rawPattern 検査対象の元パターン（エラーメッセージ用）
 * @param source RegExp に渡すパターン（matches は ^(?:...)$ で全体一致化済み）
 */
function compileRe2Pattern(rawPattern: string, source: string, flags = ""): RegExp {
  rejectRe2IncompatibleSyntax(rawPattern);
  try {
    return new RegExp(source, flags);
  } catch {
    throw new Error(`Invalid regex pattern: ${rawPattern}`);
  }
}

/** RE2 に存在しない構文（後方参照 / ルックアラウンド）を拒否する */
function rejectRe2IncompatibleSyntax(pattern: string): void {
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      const next = pattern[i + 1];
      if (next >= "1" && next <= "9") {
        throw new Error(`Invalid regex pattern (RE2 does not support backreferences): ${pattern}`);
      }
      i++; // エスケープされた文字はスキップ
      continue;
    }
    if (ch === "(" && pattern[i + 1] === "?") {
      const third = pattern[i + 2];
      const fourth = pattern[i + 3];
      if (third === "=" || third === "!" || (third === "<" && (fourth === "=" || fourth === "!"))) {
        throw new Error(
          `Invalid regex pattern (RE2 does not support lookaround assertions): ${pattern}`,
        );
      }
    }
  }
}

function assertArgCount(method: string, args: RulesValue[], expected: number): void {
  if (args.length !== expected) {
    throw new Error(`${method}() expects ${expected} argument(s), got ${args.length}`);
  }
}

function assertString(val: RulesValue, label: string): string {
  if (val.typeName !== "string") {
    throw new Error(`${label} must be a string, got ${val.typeName}`);
  }
  return val.value;
}
