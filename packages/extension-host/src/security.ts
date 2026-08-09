const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/u;
const PROTOTYPE_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const LIFECYCLE_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "prepublishOnly",
  "prepare",
  "dependencies",
]);
const CREDENTIAL =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]{12,}|\b(?:postgres(?:ql)?|mongodb(?:\+srv)?|mysql|redis):\/\/[^\s:@/]+:[^\s@/]+@/iu;

export function assertSafeArchivePath(path: string): string {
  if (
    path.length === 0 ||
    path.length > 512 ||
    path.startsWith("/") ||
    WINDOWS_ABSOLUTE.test(path) ||
    path.includes("\\") ||
    path.includes("//")
  ) {
    throw new Error(`Extension archive path가 유효하지 않습니다: ${path}`);
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === ".." || PROTOTYPE_SEGMENTS.has(segment),
    )
  ) {
    throw new Error(`Extension archive path가 유효하지 않습니다: ${path}`);
  }
  if (segments[0] !== "package" || segments.length < 2) {
    throw new Error(`Extension archive path는 package/ 아래여야 합니다: ${path}`);
  }
  return segments.slice(1).join("/");
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}은 object여야 합니다`);
  return value as Record<string, unknown>;
}

export function validatePackageSecurity(value: unknown): Readonly<Record<string, unknown>> {
  const packageJson = object(value, "package.json");
  const scripts = packageJson.scripts === undefined ? {} : object(packageJson.scripts, "package scripts");
  const forbiddenScript = Object.keys(scripts).find((name) => LIFECYCLE_SCRIPTS.has(name));
  if (forbiddenScript) throw new Error(`Extension package lifecycle script를 허용하지 않습니다: ${forbiddenScript}`);
  if (packageJson.gypfile === true || packageJson.binary !== undefined) {
    throw new Error("Extension package native addon 설정을 허용하지 않습니다");
  }
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "bundledDependencies",
    "bundleDependencies",
  ] as const) {
    if (packageJson[field] !== undefined) {
      throw new Error(`Extension package는 self-contained bundle이어야 합니다: ${field}`);
    }
  }
  return packageJson;
}

export function assertSafeExtensionFile(path: string): void {
  const lower = path.toLocaleLowerCase("en-US");
  if (lower === "binding.gyp" || lower.endsWith(".node")) {
    throw new Error(`Extension archive에 native addon을 포함할 수 없습니다: ${path}`);
  }
  if (lower === "node_modules" || lower.startsWith("node_modules/") || lower.includes("/node_modules/")) {
    throw new Error(`Extension archive에 node_modules를 포함할 수 없습니다: ${path}`);
  }
}

/**
 * 텍스트인지 판정하는 범위. git이 쓰는 것과 같은 관례입니다.
 *
 * 파일 전체에서 NUL을 찾으면 «앞은 평문인데 뒤 어딘가에 NUL이 하나 있는» 파일이 binary로 분류돼
 * 검사를 통째로 건너뜁니다. 그러면 NUL 한 바이트를 끼워 넣는 것만으로 스캔을 끌 수 있습니다.
 */
const TEXT_PROBE_BYTES = 8_000;

export function assertNoEmbeddedCredential(path: string, body: Buffer): void {
  // binary는 검사하지 않습니다. 판정은 앞부분만 봅니다 — 위 상수 설명 참고.
  if (body.subarray(0, TEXT_PROBE_BYTES).includes(0)) return;
  // 크기로는 건너뛰지 않습니다. 예전에는 1MiB를 넘으면 그대로 통과시켜서, 평문 앞에 padding을
  // 1MiB 넘게 채우고 private key를 넣으면 검사를 우회할 수 있었습니다. 보안 검사를 크기로 끄면
  // 그 크기가 곧 우회 방법이 됩니다. 비용은 package-service의 파일당 16MiB 상한이 이미 잡습니다.
  if (CREDENTIAL.test(body.toString("utf8"))) {
    throw new Error(`Extension package에서 credential 후보를 탐지했습니다: ${path}`);
  }
}
