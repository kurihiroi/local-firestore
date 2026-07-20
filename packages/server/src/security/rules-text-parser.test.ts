import { describe, expect, it } from "vitest";
import type { RuleContext } from "./rules-engine.js";
import { SecurityRulesEngine } from "./rules-engine.js";
import { looksLikeRulesText, parseRulesText } from "./rules-text-parser.js";

function makeContext(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    auth: null,
    path: "users/alice",
    documentId: "alice",
    collectionPath: "users",
    ...overrides,
  };
}

const SAMPLE_RULES = `
rules_version = '2';

// コメントも受理される
service cloud.firestore {
  match /databases/{database}/documents {
    /* ブロックコメント */
    function isSignedIn() {
      return request.auth != null;
    }

    match /users/{userId} {
      allow read: if isSignedIn() && request.auth.uid == userId;
      allow create: if isSignedIn();

      match /posts/{postId} {
        allow read;
        allow write: if request.auth.uid == userId;
      }
    }

    match /public/{docId} {
      allow read;
    }

    match /{document=**} {
      allow read, write: if false;
    }
  }
}
`;

describe("looksLikeRulesText", () => {
  it("firestore.rules テキストを判定する", () => {
    expect(looksLikeRulesText(SAMPLE_RULES)).toBe(true);
    expect(looksLikeRulesText("service cloud.firestore { }")).toBe(true);
    expect(looksLikeRulesText("// comment\nrules_version = '2';")).toBe(true);
  });

  it("JSON 形式は false", () => {
    expect(looksLikeRulesText('{ "rules": { "users": { "read": true } } }')).toBe(false);
  });
});

describe("parseRulesText", () => {
  it("構造を SecurityRules ツリーへ変換する", () => {
    const rules = parseRulesText(SAMPLE_RULES);

    // /databases/{database}/documents ラッパーは剥がされ、database はグローバル束縛
    expect(rules.globalBindings).toEqual({ database: "(default)" });

    // match /users/{userId} → rules.users（userId は documentWildcard）
    const users = rules.rules.users;
    expect(users.documentWildcard).toBe("userId");
    expect(users.read).toContain("isSignedIn()");
    expect(users.create).toBe("isSignedIn()");

    // ネストした match は subcollections["{userId}"].subcollections.posts
    const posts = users.subcollections?.["{userId}"]?.subcollections?.posts;
    expect(posts).toBeDefined();
    expect(posts?.read).toBe(true); // `allow read;` は無条件許可
    expect(posts?.write).toBe("request.auth.uid == userId");
    expect(posts?.documentWildcard).toBe("postId");

    // 再帰ワイルドカードのキャッチオール
    expect(rules.rules["{document=**}"]).toMatchObject({ read: "false", write: "false" });

    // function はグローバル関数として収集される
    expect(rules.functions).toContain("function isSignedIn()");
  });

  it("同一オペレーションへの複数 allow は OR 結合される", () => {
    const rules = parseRulesText(`
      service cloud.firestore {
        match /databases/{db}/documents {
          match /items/{id} {
            allow read: if request.auth.uid == 'a';
            allow read: if request.auth.uid == 'b';
          }
        }
      }
    `);
    expect(rules.rules.items.read).toBe("(request.auth.uid == 'a') || (request.auth.uid == 'b')");
  });

  it("固定ドキュメント ID の match は documentId 条件へ変換される", () => {
    const rules = parseRulesText(`
      service cloud.firestore {
        match /databases/{db}/documents {
          match /config/settings {
            allow read: if true;
          }
        }
      }
    `);
    expect(rules.rules.config.read).toBe("documentId == 'settings'");
  });

  it("構文エラーは行番号付きで報告される", () => {
    expect(() => parseRulesText("service cloud.firestore {\n  bogus\n}")).toThrow(/line 2/);
    expect(() =>
      parseRulesText("service cloud.firestore { match /a/{b} { allow destroy: if true; } }"),
    ).toThrow(/Invalid allow operation/);
  });
});

describe("パース済みルールのエンジン評価（本家セマンティクス）", () => {
  const engine = new SecurityRulesEngine(parseRulesText(SAMPLE_RULES));

  it("{userId} ワイルドカードに documentId が束縛される", () => {
    const own = engine.evaluate(
      "get",
      makeContext({ auth: { uid: "alice" }, path: "users/alice", documentId: "alice" }),
    );
    expect(own.allowed).toBe(true);

    const other = engine.evaluate(
      "get",
      makeContext({ auth: { uid: "bob" }, path: "users/alice", documentId: "alice" }),
    );
    expect(other.allowed).toBe(false);
  });

  it("ネストした match（サブコレクション）のワイルドカードも束縛される", () => {
    // 親パスの {userId} は経路のワイルドカードとして束縛される
    const result = engine.evaluate(
      "update",
      makeContext({
        auth: { uid: "alice" },
        path: "users/alice/posts/p1",
        documentId: "p1",
        collectionPath: "users/alice/posts",
      }),
    );
    expect(result.allowed).toBe(true);

    const denied = engine.evaluate(
      "update",
      makeContext({
        auth: { uid: "bob" },
        path: "users/alice/posts/p1",
        documentId: "p1",
        collectionPath: "users/alice/posts",
      }),
    );
    expect(denied.allowed).toBe(false);
  });

  it("`allow read;`（無条件）が許可になる", () => {
    const result = engine.evaluate(
      "get",
      makeContext({ path: "public/doc1", documentId: "doc1", collectionPath: "public" }),
    );
    expect(result.allowed).toBe(true);
  });

  it("キャッチオール（{document=**}）が未定義コレクションを拒否する", () => {
    const result = engine.evaluate(
      "get",
      makeContext({ path: "secrets/s1", documentId: "s1", collectionPath: "secrets" }),
    );
    expect(result.allowed).toBe(false);
  });

  it("database グローバル束縛が参照できる", () => {
    const engine2 = new SecurityRulesEngine(
      parseRulesText(`
        service cloud.firestore {
          match /databases/{database}/documents {
            match /items/{id} {
              allow read: if database == '(default)';
            }
          }
        }
      `),
    );
    const result = engine2.evaluate(
      "get",
      makeContext({ path: "items/i1", documentId: "i1", collectionPath: "items" }),
    );
    expect(result.allowed).toBe(true);
  });

  it("最終セグメントの {name=**} はフルパスを path 型で束縛する", () => {
    const engine3 = new SecurityRulesEngine(
      parseRulesText(`
        service cloud.firestore {
          match /databases/{db}/documents {
            match /files/{filePath=**} {
              allow read: if filePath is path && string(filePath) == 'a/sub/b';
            }
          }
        }
      `),
    );
    // 深いパス: {filePath=**} が "a/sub" を消費し、documentId "b" が連結される
    const deep = engine3.evaluate(
      "get",
      makeContext({ path: "files/a/sub/b", documentId: "b", collectionPath: "files/a/sub" }),
    );
    expect(deep.allowed).toBe(true);

    const mismatch = engine3.evaluate(
      "get",
      makeContext({ path: "files/x", documentId: "x", collectionPath: "files" }),
    );
    expect(mismatch.allowed).toBe(false);
  });

  it("関数がルール式から呼び出せる", () => {
    const result = engine.evaluate(
      "create",
      makeContext({ auth: { uid: "anyone" }, path: "users/new", documentId: "new" }),
    );
    expect(result.allowed).toBe(true);

    const denied = engine.evaluate(
      "create",
      makeContext({ auth: null, path: "users/new", documentId: "new" }),
    );
    expect(denied.allowed).toBe(false);
  });
});
