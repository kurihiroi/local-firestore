import { describe, expect, it } from "vitest";
import { DocumentValidationError } from "./limits.js";
import {
  applySetMutation,
  applyUpdateMutation,
  createServerMutationContext,
  type MutationContext,
} from "./mutation-applier.js";

const FIXED_TIME = {
  __type: "timestamp",
  value: { seconds: 1_700_000_000, nanoseconds: 0 },
} as const;

const ctx: MutationContext = {
  serverTimestamp: () => ({ ...FIXED_TIME, value: { ...FIXED_TIME.value } }),
};

const deleteSentinel = { __fieldValue: true, type: "deleteField" } as const;

describe("applySetMutation", () => {
  it("merge なしの set はデータをそのまま返す", () => {
    expect(applySetMutation({ old: 1 }, { name: "Alice" }, undefined, ctx)).toEqual({
      name: "Alice",
    });
  });

  it("merge set はネストしたマップを再帰的にマージする", () => {
    const base = { profile: { age: 30, city: "Tokyo" }, keep: 1 };
    const result = applySetMutation(base, { profile: { age: 31 } }, { merge: true }, ctx);
    expect(result).toEqual({ profile: { age: 31, city: "Tokyo" }, keep: 1 });
  });

  it("mergeFields は指定フィールドのみ反映する", () => {
    const base = { a: 1, b: 2 };
    const result = applySetMutation(base, { a: 10, b: 20 }, { mergeFields: ["a"] }, ctx);
    expect(result).toEqual({ a: 10, b: 2 });
  });

  it("serverTimestamp をコンテキストの時刻で解決する", () => {
    const result = applySetMutation(
      null,
      { at: { __fieldValue: true, type: "serverTimestamp" } },
      undefined,
      ctx,
    );
    expect(result.at).toEqual(FIXED_TIME);
  });

  it("increment / arrayUnion / arrayRemove をベース値から解決する", () => {
    const base = { count: 10, tags: ["a", "b"] };
    const result = applySetMutation(
      base,
      {
        count: { __fieldValue: true, type: "increment", value: 5 },
        tags: { __fieldValue: true, type: "arrayUnion", value: ["b", "c"] },
      },
      { merge: true },
      ctx,
    );
    expect(result.count).toBe(15);
    expect(result.tags).toEqual(["a", "b", "c"]);
  });

  it("merge なしの deleteField はエラーになる", () => {
    expect(() => applySetMutation(null, { a: deleteSentinel }, undefined, ctx)).toThrow(
      DocumentValidationError,
    );
  });

  it("merge set の deleteField はネストしたフィールドも削除する", () => {
    const base = { nested: { x: 1, y: 2 } };
    const result = applySetMutation(base, { nested: { x: deleteSentinel } }, { merge: true }, ctx);
    expect(result).toEqual({ nested: { y: 2 } });
  });

  it("ベースが存在しない merge set では deleteField マーカーを除去する", () => {
    const result = applySetMutation(
      null,
      { name: "New", gone: deleteSentinel },
      { merge: true },
      ctx,
    );
    expect(result).toEqual({ name: "New" });
  });

  it("Timestamp をマイクロ秒精度へ切り捨てる", () => {
    const result = applySetMutation(
      null,
      { at: { __type: "timestamp", value: { seconds: 1, nanoseconds: 123_456_789 } } },
      undefined,
      ctx,
    );
    expect(result.at).toEqual({
      __type: "timestamp",
      value: { seconds: 1, nanoseconds: 123_456_000 },
    });
  });
});

describe("applyUpdateMutation", () => {
  it("ドット記法キーはリーフのみ更新する（兄弟フィールド保持）", () => {
    const base = { profile: { age: 30, city: "Tokyo" } };
    const result = applyUpdateMutation(base, { "profile.age": 31 }, ctx);
    expect(result).toEqual({ profile: { age: 31, city: "Tokyo" } });
  });

  it("トップレベル（ドット記法パス含む）の deleteField はフィールドを削除する", () => {
    const base = { a: 1, nested: { x: 1, y: 2 } };
    const result = applyUpdateMutation(
      base,
      { a: deleteSentinel, "nested.x": deleteSentinel },
      ctx,
    );
    expect(result).toEqual({ nested: { y: 2 } });
  });

  it("ネストしたマップ内の deleteField はエラーになる", () => {
    expect(() =>
      applyUpdateMutation({ nested: { x: 1 } }, { nested: { x: deleteSentinel } }, ctx),
    ).toThrow(DocumentValidationError);
  });

  it("ドット記法パスの increment がベース値から解決される", () => {
    const base = { stats: { score: 10 } };
    const result = applyUpdateMutation(
      base,
      { "stats.score": { __fieldValue: true, type: "increment", value: 3 } },
      ctx,
    );
    expect(result).toEqual({ stats: { score: 13 } });
  });

  it("ベースを変更しない（イミュータブル）", () => {
    const base = { a: 1, nested: { x: 1 } };
    applyUpdateMutation(base, { "nested.x": 2, a: deleteSentinel }, ctx);
    expect(base).toEqual({ a: 1, nested: { x: 1 } });
  });
});

describe("createServerMutationContext", () => {
  it("同一コンテキスト内の serverTimestamp は常に同じ時刻に解決される", () => {
    const context = createServerMutationContext();
    const first = context.serverTimestamp();
    const second = context.serverTimestamp();
    expect(second.value).toEqual(first.value);
    // 呼び出しごとに独立したオブジェクトを返す（共有ミューテーション防止）
    expect(second.value).not.toBe(first.value);
  });

  it("commitTime を指定するとその時刻で解決される", () => {
    const context = createServerMutationContext(new Date(1_700_000_000_500));
    expect(context.serverTimestamp()).toEqual({
      __type: "timestamp",
      value: { seconds: 1_700_000_000, nanoseconds: 500_000_000 },
    });
  });

  it("1 回の set 内の複数 serverTimestamp フィールドが一致する", () => {
    const context = createServerMutationContext();
    const result = applySetMutation(
      null,
      {
        createdAt: { __fieldValue: true, type: "serverTimestamp" },
        updatedAt: { __fieldValue: true, type: "serverTimestamp" },
      },
      undefined,
      context,
    );
    expect(result.createdAt).toEqual(result.updatedAt);
  });
});
