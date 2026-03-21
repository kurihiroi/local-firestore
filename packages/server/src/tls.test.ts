import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getTlsOptionsFromEnv, loadTlsCertificates } from "./tls.js";

describe("getTlsOptionsFromEnv", () => {
  afterEach(() => {
    delete process.env.TLS_CERT_PATH;
    delete process.env.TLS_KEY_PATH;
  });

  it("should return undefined when no env vars set", () => {
    expect(getTlsOptionsFromEnv()).toBeUndefined();
  });

  it("should return undefined when only cert path is set", () => {
    process.env.TLS_CERT_PATH = "/path/to/cert.pem";
    expect(getTlsOptionsFromEnv()).toBeUndefined();
  });

  it("should return undefined when only key path is set", () => {
    process.env.TLS_KEY_PATH = "/path/to/key.pem";
    expect(getTlsOptionsFromEnv()).toBeUndefined();
  });

  it("should return options when both env vars are set", () => {
    process.env.TLS_CERT_PATH = "/path/to/cert.pem";
    process.env.TLS_KEY_PATH = "/path/to/key.pem";
    expect(getTlsOptionsFromEnv()).toEqual({
      certPath: "/path/to/cert.pem",
      keyPath: "/path/to/key.pem",
    });
  });
});

describe("loadTlsCertificates", () => {
  it("should load certificate files", () => {
    const dir = tmpdir();
    const certPath = join(dir, "test-cert.pem");
    const keyPath = join(dir, "test-key.pem");
    writeFileSync(certPath, "CERT_CONTENT");
    writeFileSync(keyPath, "KEY_CONTENT");

    const result = loadTlsCertificates({ certPath, keyPath });
    expect(result.cert).toBe("CERT_CONTENT");
    expect(result.key).toBe("KEY_CONTENT");
  });

  it("should throw when cert file does not exist", () => {
    expect(() =>
      loadTlsCertificates({ certPath: "/nonexistent/cert.pem", keyPath: "/nonexistent/key.pem" }),
    ).toThrow();
  });
});
