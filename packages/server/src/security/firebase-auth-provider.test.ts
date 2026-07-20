import { describe, expect, it, vi } from "vitest";
import { FirebaseAuthProvider } from "./firebase-auth-provider.js";

describe("FirebaseAuthProvider", () => {
  it("有効なトークンから AuthContext を返す", async () => {
    const provider = new FirebaseAuthProvider({
      verifyIdToken: vi.fn().mockResolvedValue({ uid: "u1", email: "a@example.com" }),
    });
    const auth = await provider.extractAuth("Bearer valid-token");
    expect(auth).toEqual({ uid: "u1", token: { uid: "u1", email: "a@example.com" } });
    expect(provider.verificationFailureCount).toBe(0);
  });

  it("ヘッダー無しは検証失敗としてカウントしない（トークン無し）", async () => {
    const onVerificationFailure = vi.fn();
    const provider = new FirebaseAuthProvider(
      { verifyIdToken: vi.fn() },
      { onVerificationFailure },
    );
    expect(await provider.extractAuth(undefined)).toBeNull();
    expect(provider.verificationFailureCount).toBe(0);
    expect(onVerificationFailure).not.toHaveBeenCalled();
  });

  it("検証失敗はフックで可視化され、カウントされる", async () => {
    const onVerificationFailure = vi.fn();
    const provider = new FirebaseAuthProvider(
      { verifyIdToken: vi.fn().mockRejectedValue(new Error("invalid signature")) },
      { onVerificationFailure },
    );

    expect(await provider.extractAuth("Bearer bad-token")).toBeNull();
    expect(await provider.extractAuth("Bearer bad-token")).toBeNull();

    expect(provider.verificationFailureCount).toBe(2);
    expect(onVerificationFailure).toHaveBeenCalledTimes(2);
    expect(onVerificationFailure.mock.calls[0][0]).toContain("invalid signature");
  });

  it("フック未指定時は console.error へ出力する", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const provider = new FirebaseAuthProvider({
        verifyIdToken: vi.fn().mockRejectedValue(new Error("expired")),
      });
      await provider.extractAuth("Bearer bad-token");
      expect(errorSpy).toHaveBeenCalledOnce();
      expect(String(errorSpy.mock.calls[0][0])).toContain("expired");
    } finally {
      errorSpy.mockRestore();
    }
  });
});
