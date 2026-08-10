import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, openSync, type Stats } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  attestLocalSurrealRuntime,
  LocalSurrealRuntimeManager,
  provisionLocalSurrealDatabase,
  resolveLocalSurrealRuntime,
  type LocalSurrealRuntimeState,
} from "./local-surreal-runtime.js";

export * from "./local-surreal-runtime.js";

export interface LocalPaths {
  readonly configDirectory: string;
  readonly dataDirectory: string;
  readonly stateDirectory: string;
  readonly backupDirectory: string;
  readonly softwareWorkspaceDirectory: string;
  readonly connectorDirectory: string;
  readonly tokenKey: string;
  readonly credentialKey: string;
  readonly databasePassword: string;
  readonly bootstrapDirectory: string;
  readonly startLock: string;
  readonly accessToken: string;
  readonly pidFile: string;
  readonly logFile: string;
  readonly surrealPidFile: string;
  readonly surrealLogFile: string;
  readonly epochFile: string;
}

const LOCAL_DATA_EPOCH = "massion-v1-data-epoch-1";
const LOCAL_DATA_ROOT = "massion-v1";
const LOCAL_DAEMON_READY_TIMEOUT_MS = 5 * 60_000;
const LOCAL_DAEMON_READY_POLL_MS = 250;
const LOCAL_DAEMON_READY_MAX_ATTEMPTS = LOCAL_DAEMON_READY_TIMEOUT_MS / LOCAL_DAEMON_READY_POLL_MS;
export const LOCAL_BOOTSTRAP_CAPABILITY_TTL_MS = 5 * 60_000;
const epochOperations = new Map<string, Promise<void>>();

export class LocalDataEpochMigrationRequiredError extends Error {
  public constructor() {
    super("기존 Massion 데이터의 호환성을 확인할 수 없습니다. 데이터를 보존한 채 마이그레이션 또는 복구가 필요합니다.");
    this.name = "LocalDataEpochMigrationRequiredError";
  }
}

interface LocalPidRecordV1 {
  readonly schema: "massion.local-process.v1";
  readonly pid: number;
  readonly endpoint: string;
  readonly serverScript: string;
  readonly startedAt: string;
}

interface LocalPidRecordV2 {
  readonly schema: "massion.local-process.v2";
  readonly pid: number;
  readonly endpoint: string;
  readonly nodeExecutable: string;
  readonly serverScript: string;
  readonly runtimeVersion: string;
  readonly startedAt: string;
}

interface LocalPidRecordV3 {
  readonly schema: "massion.local-process.v3";
  readonly pid: number;
  readonly endpoint: string;
  readonly nodeExecutable: string;
  readonly serverScript: string;
  readonly runtimeVersion: string;
  readonly bootstrapCapabilityFile: string;
  readonly bootstrapCapabilityDevice: string;
  readonly bootstrapCapabilityInode: string;
  readonly startedAt: string;
}

interface LocalBootstrapCapabilityBinding {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
}

type LocalPidRecord = LocalPidRecordV1 | LocalPidRecordV2 | LocalPidRecordV3;

interface SpawnedProcess {
  readonly pid?: number | undefined;
  unref(): void;
}

interface LocalSurrealRuntimeController {
  start(): Promise<{
    readonly status: "started" | "already-running";
    readonly pid: number;
    readonly endpoint: string;
  }>;
  stop(): Promise<{ readonly status: "stopped" | "already-stopped"; readonly pid?: number }>;
}

export interface LocalDaemonDependencies {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly nodeExecutable?: string;
  readonly serverScript?: string;
  readonly runtimeVersion?: string;
  readonly fetcher?: typeof fetch;
  readonly processExists?: (pid: number) => boolean;
  readonly processCommand?: (pid: number) => Promise<string>;
  readonly signal?: (pid: number, signal: NodeJS.Signals) => void;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly spawnProcess?: (
    command: string,
    arguments_: readonly string[],
    options: {
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly stdout: number;
      readonly stderr: number;
    },
  ) => SpawnedProcess;
  readonly surrealRuntime?: LocalSurrealRuntimeController;
  readonly beforeBootstrapCreateFailureCleanup?: () => void | Promise<void>;
  readonly beforeBootstrapCleanup?: () => void | Promise<void>;
  readonly beforeStartLockRetire?: () => void | Promise<void>;
}

function directory(
  environment: Readonly<Record<string, string | undefined>>,
  variable: string,
  fallback: string,
): string {
  const value = environment[variable];
  return value ? resolve(value) : fallback;
}

export function resolveLocalPaths(environment: Readonly<Record<string, string | undefined>> = process.env): LocalPaths {
  const home = resolve(environment.HOME ?? homedir());
  const configDirectory = join(directory(environment, "XDG_CONFIG_HOME", join(home, ".config")), LOCAL_DATA_ROOT);
  const dataDirectory = join(directory(environment, "XDG_DATA_HOME", join(home, ".local", "share")), LOCAL_DATA_ROOT);
  const stateDirectory = join(directory(environment, "XDG_STATE_HOME", join(home, ".local", "state")), LOCAL_DATA_ROOT);
  return {
    configDirectory,
    dataDirectory,
    stateDirectory,
    backupDirectory: join(dataDirectory, "backups"),
    softwareWorkspaceDirectory: join(dataDirectory, "workspaces"),
    connectorDirectory: join(dataDirectory, "connectors"),
    tokenKey: join(configDirectory, "token-key"),
    credentialKey: join(configDirectory, "credential-key"),
    databasePassword: join(configDirectory, "database-password"),
    bootstrapDirectory: join(stateDirectory, "bootstrap"),
    startLock: join(stateDirectory, "server.start.lock"),
    accessToken: join(configDirectory, "access.token"),
    pidFile: join(stateDirectory, "server.json"),
    logFile: join(stateDirectory, "server.log"),
    surrealPidFile: join(stateDirectory, "surrealdb.json"),
    surrealLogFile: join(stateDirectory, "surrealdb.log"),
    epochFile: join(configDirectory, ".massion-data-epoch"),
  };
}

/** 새 설치 또는 빈 v1 root만 현재 epoch로 초기화하고, 기존 데이터는 자동으로 삭제하지 않습니다. */
export async function ensureLocalDataEpoch(paths: LocalPaths): Promise<void> {
  const key = [paths.configDirectory, paths.dataDirectory, paths.stateDirectory].sort().join("\0");
  const previous = epochOperations.get(key) ?? Promise.resolve();
  const current = previous.then(() => ensureLocalDataEpochExclusive(paths));
  epochOperations.set(key, current);
  try {
    await current;
  } finally {
    if (epochOperations.get(key) === current) epochOperations.delete(key);
  }
}

async function ensureLocalDataEpochExclusive(paths: LocalPaths): Promise<void> {
  const roots = [...new Set([paths.configDirectory, paths.dataDirectory, paths.stateDirectory])];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const states = await Promise.all(roots.map(async (root) => await readLocalDataEpochRoot(root)));
      if (states.every(({ marker }) => marker === `${LOCAL_DATA_EPOCH}\n`)) return;
      if (states.some(({ dataBearing }) => dataBearing)) throw new LocalDataEpochMigrationRequiredError();

      for (const { root } of states) {
        await mkdir(root, { recursive: true, mode: 0o700 });
      }
      const initializedStates = [];
      for (const root of roots) initializedStates.push(await readLocalDataEpochRoot(root));
      if (initializedStates.every(({ marker }) => marker === `${LOCAL_DATA_EPOCH}\n`)) return;
      if (initializedStates.some(({ dataBearing }) => dataBearing)) throw new LocalDataEpochMigrationRequiredError();

      for (const { root, marker } of initializedStates) {
        await writeFile(join(root, ".massion-data-epoch"), `${LOCAL_DATA_EPOCH}\n`, {
          mode: 0o600,
          flag: marker === undefined ? "wx" : "w",
        });
      }
      return;
    } catch (error) {
      if (
        attempt === 2 ||
        !(error instanceof Error) ||
        !("code" in error) ||
        !["EEXIST", "ENOENT", "ENOTEMPTY"].includes(String(error.code))
      )
        throw error;
    }
  }
}

async function readLocalDataEpochRoot(root: string): Promise<{
  readonly root: string;
  readonly marker: string | undefined;
  readonly dataBearing: boolean;
}> {
  try {
    const metadata = await lstat(root);
    if (metadata.isSymbolicLink()) throw new Error("Massion v1 data root에 symlink를 사용할 수 없습니다");
    if (!metadata.isDirectory()) throw new Error("Massion v1 data root는 directory여야 합니다");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { root, marker: undefined, dataBearing: false };
    }
    throw error;
  }

  const markerPath = join(root, ".massion-data-epoch");
  let marker: string | undefined;
  try {
    if ((await lstat(markerPath)).isSymbolicLink()) {
      throw new Error("Massion v1 data epoch marker에 symlink를 사용할 수 없습니다");
    }
    marker = await readFile(markerPath, "utf8");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  return {
    root,
    marker,
    dataBearing: (await readdir(root)).some((entry) => entry !== ".massion-data-epoch"),
  };
}

async function ensureDirectories(paths: LocalPaths): Promise<void> {
  await Promise.all(
    [
      paths.configDirectory,
      paths.dataDirectory,
      paths.stateDirectory,
      paths.backupDirectory,
      paths.softwareWorkspaceDirectory,
      paths.connectorDirectory,
      paths.bootstrapDirectory,
    ].map(async (path) => {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const metadata = await stat(path);
      if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0)
        throw new Error(`local directory는 owner-only여야 합니다: ${path}`);
      if (
        path === paths.bootstrapDirectory &&
        ((process.platform !== "win32" && (metadata.mode & 0o777) !== 0o700) ||
          (process.getuid?.() !== undefined && metadata.uid !== process.getuid()))
      )
        throw new Error("local bootstrap directory 신뢰 검증에 실패했습니다");
    }),
  );
}

export async function ensureLocalTokenKey(paths: LocalPaths): Promise<string> {
  await ensureDirectories(paths);
  try {
    const metadata = await stat(paths.tokenKey);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) throw new Error("local token key는 owner-only여야 합니다");
    const value = (await readFile(paths.tokenKey, "utf8")).trim();
    if (Buffer.from(value, "base64url").length !== 32) throw new Error("local token key가 유효하지 않습니다");
    return value;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const value = randomBytes(32).toString("base64url");
  try {
    await writeFile(paths.tokenKey, `${value}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    return await ensureLocalTokenKey(paths);
  }
  return value;
}

export async function ensureLocalCredentialKey(paths: LocalPaths): Promise<string> {
  await ensureDirectories(paths);
  try {
    const metadata = await stat(paths.credentialKey);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0)
      throw new Error("local credential key는 owner-only여야 합니다");
    const value = (await readFile(paths.credentialKey, "utf8")).trim();
    if (Buffer.from(value, "base64url").length !== 32) throw new Error("local credential key가 유효하지 않습니다");
    return value;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const value = randomBytes(32).toString("base64url");
  try {
    await writeFile(paths.credentialKey, `${value}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    return await ensureLocalCredentialKey(paths);
  }
  return value;
}

export async function ensureLocalDatabasePassword(paths: LocalPaths): Promise<string> {
  await ensureDirectories(paths);
  try {
    const metadata = await stat(paths.databasePassword);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0)
      throw new Error("local SurrealDB password는 owner-only여야 합니다");
    const value = (await readFile(paths.databasePassword, "utf8")).trim();
    if (Buffer.from(value, "base64url").length !== 32) throw new Error("local SurrealDB password가 유효하지 않습니다");
    return value;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const value = randomBytes(32).toString("base64url");
  try {
    await writeFile(paths.databasePassword, `${value}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    return await ensureLocalDatabasePassword(paths);
  }
  return value;
}

function localBootstrapPath(paths: LocalPaths, path: string): string {
  const resolved = resolve(path);
  if (
    dirname(resolved) !== resolve(paths.bootstrapDirectory) ||
    !/^[0-9a-f-]{36}\.cap$/u.test(resolved.split("/").at(-1) ?? "")
  )
    throw new Error("local bootstrap capability 경로 신뢰 검증에 실패했습니다");
  return resolved;
}

function assertLocalBootstrapFile(metadata: Stats, sizes: readonly number[] = [32]): void {
  if (!metadata.isFile() || metadata.nlink !== 1 || !sizes.includes(metadata.size))
    throw new Error("local bootstrap capability 파일 신뢰 검증에 실패했습니다");
  if (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o600)
    throw new Error("local bootstrap capability 파일 신뢰 검증에 실패했습니다");
  if (process.getuid?.() !== undefined && metadata.uid !== process.getuid())
    throw new Error("local bootstrap capability 파일 신뢰 검증에 실패했습니다");
}

async function createLocalBootstrapCapability(
  paths: LocalPaths,
  beforeFailureCleanup?: () => void | Promise<void>,
): Promise<{
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly capability: Buffer;
  readonly expiresAt: number;
}> {
  await ensureDirectories(paths);
  const path = join(paths.bootstrapDirectory, `${randomUUID()}.cap`);
  const capability = randomBytes(32);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let binding: LocalBootstrapCapabilityBinding | undefined;
  try {
    handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const opened = await handle.stat();
    assertLocalBootstrapFile(opened, [0]);
    binding = { path, device: String(opened.dev), inode: String(opened.ino) };
    await handle.writeFile(capability);
    await handle.sync();
    const metadata = await handle.stat();
    assertLocalBootstrapFile(metadata);
    return {
      path,
      device: String(metadata.dev),
      inode: String(metadata.ino),
      capability,
      expiresAt: Math.min(
        Math.floor(metadata.mtimeMs) + LOCAL_BOOTSTRAP_CAPABILITY_TTL_MS,
        Date.now() + LOCAL_BOOTSTRAP_CAPABILITY_TTL_MS,
      ),
    };
  } catch (error) {
    capability.fill(0);
    if (handle && binding) {
      try {
        await sanitizeOpenedLocalBootstrapCapability(
          handle,
          binding,
          beforeFailureCleanup,
          Array.from({ length: 33 }, (_, size) => size),
        );
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `${String(error)}; capability cleanup failed`, {
          cause: cleanupError,
        });
      }
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readLocalBootstrapCapability(
  paths: LocalPaths,
  binding: LocalBootstrapCapabilityBinding,
  beforeCleanup?: () => void | Promise<void>,
): Promise<{ readonly capability: Buffer; readonly expiresAt: number } | undefined> {
  const trustedPath = localBootstrapPath(paths, binding.path);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let capability: Buffer | undefined;
  try {
    handle = await open(trustedPath, constants.O_RDWR | constants.O_NOFOLLOW);
    const before = await handle.stat();
    assertLocalBootstrapFile(before, [0, 32]);
    if (String(before.dev) !== binding.device || String(before.ino) !== binding.inode)
      throw new Error("local bootstrap capability 인스턴스 binding 검증에 실패했습니다");
    if (before.size === 0) return undefined;
    const expiresAt = Math.min(
      Math.floor(before.mtimeMs) + LOCAL_BOOTSTRAP_CAPABILITY_TTL_MS,
      Date.now() + LOCAL_BOOTSTRAP_CAPABILITY_TTL_MS,
    );
    if (Date.now() >= expiresAt) {
      await sanitizeOpenedLocalBootstrapCapability(handle, binding, beforeCleanup, [32]);
      return undefined;
    }
    capability = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      capability.length !== 32
    )
      throw new Error("local bootstrap capability 파일 교체 검증에 실패했습니다");
    return { capability, expiresAt };
  } catch (error) {
    capability?.fill(0);
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function sanitizeLocalBootstrapCapability(
  paths: LocalPaths,
  binding: LocalBootstrapCapabilityBinding | undefined,
  beforeCleanup?: () => void | Promise<void>,
): Promise<void> {
  if (binding === undefined) return;
  const trustedPath = localBootstrapPath(paths, binding.path);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(trustedPath, constants.O_RDWR | constants.O_NOFOLLOW);
    await sanitizeOpenedLocalBootstrapCapability(handle, binding, beforeCleanup, [0, 32]);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function sanitizeOpenedLocalBootstrapCapability(
  handle: Awaited<ReturnType<typeof open>>,
  binding: LocalBootstrapCapabilityBinding,
  beforeCleanup: (() => void | Promise<void>) | undefined,
  allowedSizes: readonly number[],
): Promise<void> {
  const opened = await handle.stat();
  if (!opened.isFile() || String(opened.dev) !== binding.device || String(opened.ino) !== binding.inode)
    throw new Error("local bootstrap capability cleanup binding 검증에 실패했습니다");
  await beforeCleanup?.();
  const current = await handle.stat();
  if (!current.isFile() || String(current.dev) !== binding.device || String(current.ino) !== binding.inode)
    throw new Error("local bootstrap capability cleanup fd 검증에 실패했습니다");
  if (current.nlink === 0) return;
  if (
    current.nlink !== 1 ||
    !allowedSizes.includes(current.size) ||
    (process.platform !== "win32" && (current.mode & 0o777) !== 0o600) ||
    (process.getuid?.() !== undefined && current.uid !== process.getuid())
  )
    throw new Error("local bootstrap capability cleanup 신뢰 검증에 실패했습니다");
  await handle.truncate(0);
  await handle.sync();
}

function bootstrapBinding(record: LocalPidRecord): LocalBootstrapCapabilityBinding | undefined {
  return record.schema === "massion.local-process.v3"
    ? {
        path: record.bootstrapCapabilityFile,
        device: record.bootstrapCapabilityDevice,
        inode: record.bootstrapCapabilityInode,
      }
    : undefined;
}

function validatePidRecord(value: unknown): LocalPidRecord {
  if (
    !value ||
    typeof value !== "object" ||
    !("schema" in value) ||
    !["massion.local-process.v1", "massion.local-process.v2", "massion.local-process.v3"].includes(
      String(value.schema),
    ) ||
    !("pid" in value) ||
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) < 1 ||
    !("endpoint" in value) ||
    typeof value.endpoint !== "string" ||
    !("serverScript" in value) ||
    typeof value.serverScript !== "string" ||
    !isAbsolute(value.serverScript) ||
    !("startedAt" in value) ||
    typeof value.startedAt !== "string"
  )
    throw new Error("local process state가 유효하지 않습니다");
  if (
    (value.schema === "massion.local-process.v2" || value.schema === "massion.local-process.v3") &&
    (!("nodeExecutable" in value && typeof value.nodeExecutable === "string" && isAbsolute(value.nodeExecutable)) ||
      !(
        "runtimeVersion" in value &&
        typeof value.runtimeVersion === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(value.runtimeVersion)
      ))
  )
    throw new Error("local process state runtime identity가 유효하지 않습니다");
  if (
    value.schema === "massion.local-process.v3" &&
    (!(
      "bootstrapCapabilityFile" in value &&
      typeof value.bootstrapCapabilityFile === "string" &&
      isAbsolute(value.bootstrapCapabilityFile)
    ) ||
      !/^[0-9a-f-]{36}\.cap$/u.test(value.bootstrapCapabilityFile.split("/").at(-1) ?? "") ||
      !("bootstrapCapabilityDevice" in value && /^\d+$/u.test(String(value.bootstrapCapabilityDevice))) ||
      !("bootstrapCapabilityInode" in value && /^\d+$/u.test(String(value.bootstrapCapabilityInode))))
  )
    throw new Error("local process state bootstrap capability 경로가 유효하지 않습니다");
  return value as LocalPidRecord;
}

async function readPidRecord(path: string): Promise<LocalPidRecord | undefined> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0)
      throw new Error("local process state는 owner-only여야 합니다");
    return validatePidRecord(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writePidRecord(path: string, record: LocalPidRecord): Promise<void> {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

interface LocalSurrealPidRecord extends LocalSurrealRuntimeState {
  readonly schema: "massion.local-surrealdb.v1";
}

function validateSurrealPidRecord(value: unknown): LocalSurrealRuntimeState {
  if (
    !value ||
    typeof value !== "object" ||
    !("schema" in value) ||
    value.schema !== "massion.local-surrealdb.v1" ||
    !("pid" in value) ||
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) < 1 ||
    !("endpoint" in value) ||
    typeof value.endpoint !== "string" ||
    !("executable" in value) ||
    typeof value.executable !== "string" ||
    !isAbsolute(value.executable) ||
    !("startedAt" in value) ||
    typeof value.startedAt !== "string" ||
    ("memoryProfile" in value && typeof value.memoryProfile !== "string")
  )
    throw new Error("local SurrealDB process state가 유효하지 않습니다");
  return value as LocalSurrealPidRecord;
}

async function readSurrealPidRecord(path: string): Promise<LocalSurrealRuntimeState | undefined> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0)
      throw new Error("local SurrealDB process state는 owner-only여야 합니다");
    return validateSurrealPidRecord(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeSurrealPidRecord(path: string, state: LocalSurrealRuntimeState): Promise<void> {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  const record: LocalSurrealPidRecord = { schema: "massion.local-surrealdb.v1", ...state };
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

function defaultProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function defaultProcessCommand(pid: number): Promise<string> {
  if (platform() === "linux") {
    return (await readFile(`/proc/${String(pid)}/cmdline`, "utf8")).replaceAll("\0", " ").trim();
  }
  const child = spawn("ps", ["-ww", "-p", String(pid), "-o", "command="], { stdio: ["ignore", "pipe", "ignore"] });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  const code = await new Promise<number | null>((resolveCode) => child.once("close", resolveCode));
  if (code !== 0) throw new Error("local process command를 확인하지 못했습니다");
  return Buffer.concat(chunks).toString("utf8").trim();
}

function port(environment: Readonly<Record<string, string | undefined>>): number {
  const value = environment.MASSION_LOCAL_PORT ?? "7331";
  if (!/^[1-9][0-9]{0,4}$/u.test(value) || Number(value) > 65_535)
    throw new Error("MASSION_LOCAL_PORT가 유효하지 않습니다");
  return Number(value);
}

function surrealPort(environment: Readonly<Record<string, string | undefined>>): number {
  const value = environment.MASSION_SURREAL_PORT ?? "7330";
  if (!/^[1-9][0-9]{0,4}$/u.test(value) || Number(value) > 65_535)
    throw new Error("MASSION_SURREAL_PORT가 유효하지 않습니다");
  return Number(value);
}

function applicationDatabaseEndpoint(sidecarEndpoint: string): string {
  const endpoint = new URL(sidecarEndpoint);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/")
    throw new Error("local SurrealDB sidecar endpoint가 유효하지 않습니다");
  endpoint.protocol = "ws:";
  return endpoint.toString().replace(/\/$/u, "");
}

async function acquireLocalStartLock(
  paths: LocalPaths,
  processExists: (pid: number) => boolean,
  wait: (milliseconds: number) => Promise<void>,
  beforeRetire?: () => void | Promise<void>,
): Promise<() => Promise<void>> {
  await ensureDirectories(paths);
  for (let attempt = 0; attempt < 400; attempt += 1) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let created = false;
    try {
      handle = await open(
        paths.startLock,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      created = true;
      const owned = await handle.stat();
      if (
        !owned.isFile() ||
        owned.nlink !== 1 ||
        (process.platform !== "win32" && (owned.mode & 0o777) !== 0o600) ||
        (process.getuid?.() !== undefined && owned.uid !== process.getuid())
      )
        throw new Error("local daemon 시작 lock 신뢰 검증에 실패했습니다");
      await handle.writeFile(`${String(process.pid)}\n`);
      await handle.sync();
      return async () => {
        try {
          await handle?.close();
        } finally {
          handle = undefined;
          await retireLocalStartLock(paths.startLock, beforeRetire);
        }
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      handle = undefined;
      if (created) {
        await retireLocalStartLock(paths.startLock, beforeRetire);
        throw error;
      }
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      let current: Awaited<ReturnType<typeof open>> | undefined;
      try {
        current = await open(paths.startLock, constants.O_RDONLY | constants.O_NOFOLLOW);
        const metadata = await current.stat();
        if (
          !metadata.isFile() ||
          metadata.nlink !== 1 ||
          (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o600) ||
          (process.getuid?.() !== undefined && metadata.uid !== process.getuid())
        )
          throw new Error("local daemon 시작 lock 신뢰 검증에 실패했습니다", { cause: error });
        const owner = (await current.readFile("utf8")).trim();
        if (!/^[1-9][0-9]*$/u.test(owner))
          throw new Error("local daemon 시작 lock owner가 유효하지 않습니다", { cause: error });
        if (!processExists(Number(owner))) {
          await current.close();
          current = undefined;
          await retireLocalStartLock(paths.startLock, beforeRetire);
          continue;
        }
      } finally {
        await current?.close().catch(() => undefined);
      }
      await wait(100);
    }
  }
  throw new Error("local daemon 시작 lock 대기 시간을 초과했습니다");
}

async function retireLocalStartLock(path: string, beforeRetire?: () => void | Promise<void>): Promise<void> {
  await beforeRetire?.();
  try {
    await rename(path, `${path}.retired-${randomUUID()}`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

export class LocalDaemonManager {
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #paths: LocalPaths;
  readonly #nodeExecutable: string;
  readonly #serverScript: string;
  readonly #runtimeVersion: string;
  readonly #fetcher: typeof fetch;
  readonly #processExists: (pid: number) => boolean;
  readonly #processCommand: (pid: number) => Promise<string>;
  readonly #signal: (pid: number, signal: NodeJS.Signals) => void;
  readonly #wait: (milliseconds: number) => Promise<void>;
  readonly #spawnProcess: NonNullable<LocalDaemonDependencies["spawnProcess"]>;
  readonly #beforeBootstrapCreateFailureCleanup: (() => void | Promise<void>) | undefined;
  readonly #beforeBootstrapCleanup: (() => void | Promise<void>) | undefined;
  readonly #beforeStartLockRetire: (() => void | Promise<void>) | undefined;
  #surrealRuntime: LocalSurrealRuntimeController | undefined;
  #bootstrapCapability: Buffer | undefined;
  #bootstrapCapabilityBinding: LocalBootstrapCapabilityBinding | undefined;
  #bootstrapCapabilityTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(dependencies: LocalDaemonDependencies = {}) {
    this.#environment = dependencies.environment ?? process.env;
    this.#paths = resolveLocalPaths(this.#environment);
    const nodeExecutable = dependencies.nodeExecutable ?? process.execPath;
    const serverScript = dependencies.serverScript ?? this.#environment.MASSION_SERVER_BIN;
    const runtimeVersion = dependencies.runtimeVersion ?? process.version;
    if (!isAbsolute(nodeExecutable)) throw new Error("local Node executable 절대 경로가 필요합니다");
    if (!serverScript || !isAbsolute(serverScript)) throw new Error("MASSION_SERVER_BIN 절대 경로가 필요합니다");
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(runtimeVersion))
      throw new Error("local runtime version이 유효하지 않습니다");
    this.#nodeExecutable = resolve(nodeExecutable);
    this.#serverScript = resolve(serverScript);
    this.#runtimeVersion = runtimeVersion;
    this.#fetcher = dependencies.fetcher ?? fetch;
    this.#processExists = dependencies.processExists ?? defaultProcessExists;
    this.#processCommand = dependencies.processCommand ?? defaultProcessCommand;
    this.#signal = dependencies.signal ?? ((pid, signal) => process.kill(pid, signal));
    this.#wait =
      dependencies.wait ??
      (async (milliseconds) => {
        await new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
      });
    this.#spawnProcess =
      dependencies.spawnProcess ??
      ((command, arguments_, options) => {
        const child = spawn(command, [...arguments_], {
          detached: true,
          cwd: options.cwd,
          env: options.env,
          stdio: ["ignore", options.stdout, options.stderr],
        });
        return child;
      });
    this.#beforeBootstrapCreateFailureCleanup = dependencies.beforeBootstrapCreateFailureCleanup;
    this.#beforeBootstrapCleanup = dependencies.beforeBootstrapCleanup;
    this.#beforeStartLockRetire = dependencies.beforeStartLockRetire;
    this.#surrealRuntime = dependencies.surrealRuntime;
  }

  #current(record: LocalPidRecord): boolean {
    return (
      record.schema === "massion.local-process.v3" &&
      record.nodeExecutable === this.#nodeExecutable &&
      record.serverScript === this.#serverScript &&
      record.runtimeVersion === this.#runtimeVersion &&
      record.endpoint === `http://127.0.0.1:${String(port(this.#environment))}`
    );
  }

  async #owned(record: LocalPidRecord): Promise<boolean> {
    if (!this.#processExists(record.pid)) return false;
    const command = await this.#processCommand(record.pid).catch(() => "");
    const nodeExecutable =
      record.schema === "massion.local-process.v2" || record.schema === "massion.local-process.v3"
        ? record.nodeExecutable
        : this.#nodeExecutable;
    const expected = `${nodeExecutable} ${record.serverScript}`;
    return command === expected || command.startsWith(`${expected} `);
  }

  async #terminate(record: LocalPidRecord): Promise<void> {
    this.#signal(record.pid, "SIGTERM");
    for (let attempt = 0; attempt < 120 && this.#processExists(record.pid); attempt += 1) await this.#wait(250);
    if (this.#processExists(record.pid)) throw new Error("local Massion server 정상 종료 시간을 초과했습니다");
    await rm(this.#paths.pidFile, { force: true });
  }

  async #ready(endpoint: string): Promise<boolean> {
    try {
      const response = await this.#fetcher(`${endpoint}/health/ready`, { signal: AbortSignal.timeout(1_000) });
      if (!response.ok) return false;
      const body: unknown = await response.json();
      return Boolean(body && typeof body === "object" && "status" in body && body.status === "ready");
    } catch {
      return false;
    }
  }

  #serverEnvironment(databaseEndpoint: string, bootstrapCapabilityFile?: string): NodeJS.ProcessEnv {
    return {
      PATH: this.#environment.PATH,
      HOME: this.#environment.HOME,
      TMPDIR: this.#environment.TMPDIR,
      NODE_ENV: "production",
      MASSION_VERSION: this.#environment.MASSION_VERSION ?? "1.0.0",
      MASSION_MODE: "local",
      MASSION_DATABASE_URL: applicationDatabaseEndpoint(databaseEndpoint),
      MASSION_DATABASE_USER: "massion",
      MASSION_DATABASE_PASSWORD_FILE: this.#paths.databasePassword,
      ...(bootstrapCapabilityFile === undefined ? {} : { MASSION_BOOTSTRAP_CAPABILITY_FILE: bootstrapCapabilityFile }),
      ...(this.#environment.MASSION_REGISTRY_BUNDLED_EXTENSIONS === undefined
        ? {}
        : { MASSION_REGISTRY_BUNDLED_EXTENSIONS: this.#environment.MASSION_REGISTRY_BUNDLED_EXTENSIONS }),
      MASSION_TOKEN_KEY_FILE: this.#paths.tokenKey,
      MASSION_CREDENTIAL_KEY_FILE: this.#paths.credentialKey,
      MASSION_SOFTWARE_WORKSPACE_ROOT: this.#paths.softwareWorkspaceDirectory,
      MASSION_CONNECTOR_ROOT: this.#paths.connectorDirectory,
      MASSION_EDGE_CONNECTOR_ENABLED: this.#environment.MASSION_EDGE_CONNECTOR_ENABLED ?? "false",
      MASSION_CONNECTOR_HEARTBEAT_MS: this.#environment.MASSION_CONNECTOR_HEARTBEAT_MS ?? "30000",
      MASSION_HTTP_PORT: String(port(this.#environment)),
      MASSION_REGISTRY_PORT: String(port(this.#environment) + 1),
      MASSION_METRICS_PORT: String(port(this.#environment) + 2),
      MASSION_REGISTRY_ARTIFACT_ROOT: join(this.#paths.dataDirectory, "registry"),
    };
  }

  async #localSurrealRuntime(): Promise<LocalSurrealRuntimeController> {
    if (this.#surrealRuntime) return this.#surrealRuntime;
    const binary = this.#environment.MASSION_SURREAL_BINARY;
    const expectedDigest = this.#environment.MASSION_SURREAL_SHA256;
    if (!binary || !expectedDigest)
      throw new Error("Massion native SurrealDB runtime이 준비되지 않았습니다. 설치를 다시 실행해 주세요");
    if (!isAbsolute(binary)) throw new Error("MASSION_SURREAL_BINARY 절대 경로가 필요합니다");
    const runtime = resolveLocalSurrealRuntime({
      ...(this.#environment.HOME === undefined ? {} : { home: this.#environment.HOME }),
      ...(this.#environment.XDG_DATA_HOME === undefined ? {} : { xdgDataHome: this.#environment.XDG_DATA_HOME }),
    });
    const sourceExecutable = resolve(binary);
    const executable = runtime.binaryPath;
    if (sourceExecutable !== runtime.binaryPath) {
      const sourceMetadata = await lstat(sourceExecutable);
      if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isFile() || (sourceMetadata.mode & 0o111) === 0) {
        throw new Error("Massion native SurrealDB bundle이 실행 가능한 regular file이 아닙니다");
      }
      // 번들 sidecar를 사용자 전용 runtime 경계로 복사한 뒤 기존 digest·소유권 검증을 적용합니다.
      await mkdir(dirname(runtime.binaryPath), { recursive: true, mode: 0o700 });
      const temporary = `${runtime.binaryPath}.${randomUUID()}.tmp`;
      try {
        await copyFile(sourceExecutable, temporary, constants.COPYFILE_EXCL);
        await chmod(temporary, 0o700);
        await rename(temporary, runtime.binaryPath);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    const sidecarPort = surrealPort(this.#environment);
    if (sidecarPort === port(this.#environment))
      throw new Error("MASSION_SURREAL_PORT와 MASSION_LOCAL_PORT는 달라야 합니다");
    const password = await ensureLocalDatabasePassword(this.#paths);
    const manager = new LocalSurrealRuntimeManager({
      runtime,
      credential: { user: "massion", password },
      port: sidecarPort,
      attest: async () =>
        await attestLocalSurrealRuntime({
          executable,
          expectedDigest,
          runtimeRoot: dirname(executable),
        }),
      prepareDataDirectory: async () => {
        await mkdir(runtime.dataDirectory, { recursive: true, mode: 0o700 });
        const metadata = await stat(runtime.dataDirectory);
        if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0)
          throw new Error("local SurrealDB data directory는 owner-only여야 합니다");
      },
      readState: async () => await readSurrealPidRecord(this.#paths.surrealPidFile),
      writeState: async (state) => {
        await writeSurrealPidRecord(this.#paths.surrealPidFile, state);
      },
      removeState: async () => {
        await rm(this.#paths.surrealPidFile, { force: true });
      },
      spawn: (command, arguments_, options) => {
        const logDescriptor = openSync(this.#paths.surrealLogFile, "a", 0o600);
        try {
          return spawn(command, [...arguments_], {
            detached: true,
            cwd: options.cwd,
            env: options.env,
            stdio: ["ignore", logDescriptor, logDescriptor],
          });
        } finally {
          closeSync(logDescriptor);
        }
      },
      processExists: this.#processExists,
      processCommand: this.#processCommand,
      ready: async (endpoint) => {
        try {
          return (await this.#fetcher(`${endpoint}/health`, { signal: AbortSignal.timeout(1_000) })).ok;
        } catch {
          return false;
        }
      },
      provision: async (endpoint) => {
        await provisionLocalSurrealDatabase({
          endpoint,
          credential: { user: "massion", password },
          fetcher: this.#fetcher,
        });
      },
      signal: this.#signal,
      wait: this.#wait,
    });
    this.#surrealRuntime = manager;
    return manager;
  }

  async initializeStateForTest(input: { readonly pid: number; readonly endpoint: string }): Promise<void> {
    await ensureLocalDataEpoch(this.#paths);
    await ensureDirectories(this.#paths);
    const bootstrap = await createLocalBootstrapCapability(this.#paths, this.#beforeBootstrapCreateFailureCleanup);
    this.#holdBootstrapCapability(bootstrap);
    await writePidRecord(this.#paths.pidFile, {
      schema: "massion.local-process.v3",
      pid: input.pid,
      endpoint: input.endpoint,
      nodeExecutable: this.#nodeExecutable,
      serverScript: this.#serverScript,
      runtimeVersion: this.#runtimeVersion,
      bootstrapCapabilityFile: bootstrap.path,
      bootstrapCapabilityDevice: bootstrap.device,
      bootstrapCapabilityInode: bootstrap.inode,
      startedAt: new Date(0).toISOString(),
    });
  }

  takeBootstrapCapability(): string | undefined {
    const capability = this.#bootstrapCapability;
    this.#bootstrapCapability = undefined;
    if (this.#bootstrapCapabilityTimer) clearTimeout(this.#bootstrapCapabilityTimer);
    this.#bootstrapCapabilityTimer = undefined;
    if (capability === undefined) return undefined;
    try {
      return capability.toString("base64url");
    } finally {
      capability.fill(0);
    }
  }

  discardBootstrapCapability(): void {
    if (this.#bootstrapCapabilityTimer) clearTimeout(this.#bootstrapCapabilityTimer);
    this.#bootstrapCapabilityTimer = undefined;
    const capability = this.#bootstrapCapability;
    this.#bootstrapCapability = undefined;
    capability?.fill(0);
  }

  #holdBootstrapCapability(input: {
    readonly path: string;
    readonly device: string;
    readonly inode: string;
    readonly capability: Buffer;
    readonly expiresAt: number;
  }): void {
    this.discardBootstrapCapability();
    this.#bootstrapCapability = input.capability;
    this.#bootstrapCapabilityBinding = { path: input.path, device: input.device, inode: input.inode };
    const owned = input.capability;
    const remaining = Math.max(0, input.expiresAt - Date.now());
    this.#bootstrapCapabilityTimer = setTimeout(
      () => {
        if (this.#bootstrapCapability !== owned) return;
        this.#bootstrapCapabilityTimer = undefined;
        this.#bootstrapCapability = undefined;
        owned.fill(0);
      },
      Math.min(remaining, 2_147_483_647),
    );
    this.#bootstrapCapabilityTimer.unref();
  }

  async start(): Promise<{
    readonly status: "started" | "already-running";
    readonly pid: number;
    readonly endpoint: string;
  }> {
    await ensureLocalDataEpoch(this.#paths);
    const release = await acquireLocalStartLock(
      this.#paths,
      this.#processExists,
      this.#wait,
      this.#beforeStartLockRetire,
    );
    try {
      return await this.#startUnlocked();
    } finally {
      await release();
    }
  }

  async #startUnlocked(): Promise<{
    readonly status: "started" | "already-running";
    readonly pid: number;
    readonly endpoint: string;
  }> {
    await ensureLocalDataEpoch(this.#paths);
    await Promise.all([
      ensureLocalTokenKey(this.#paths),
      ensureLocalCredentialKey(this.#paths),
      ensureLocalDatabasePassword(this.#paths),
    ]);
    const existing = await readPidRecord(this.#paths.pidFile);
    if (existing) {
      if (await this.#owned(existing)) {
        if (this.#current(existing)) {
          // 현재 runtime이면 준비 완료 또는 부팅 중인 process를 재사용한다.
          const readyDeadline = performance.now() + LOCAL_DAEMON_READY_TIMEOUT_MS;
          for (
            let attempt = 0;
            attempt < LOCAL_DAEMON_READY_MAX_ATTEMPTS && performance.now() < readyDeadline;
            attempt += 1
          ) {
            if (await this.#ready(existing.endpoint)) {
              const binding = bootstrapBinding(existing);
              if (!binding) throw new Error("local bootstrap capability binding이 없습니다");
              const bootstrap = await readLocalBootstrapCapability(this.#paths, binding, this.#beforeBootstrapCleanup);
              if (bootstrap === undefined) {
                this.discardBootstrapCapability();
                this.#bootstrapCapabilityBinding = binding;
              } else {
                this.#holdBootstrapCapability({ ...binding, ...bootstrap });
              }
              return { status: "already-running", pid: existing.pid, endpoint: existing.endpoint };
            }
            if (!this.#processExists(existing.pid)) break;
            await this.#wait(LOCAL_DAEMON_READY_POLL_MS);
          }
        }
        // 구 schema·runtime 불일치·준비 실패 상태는 소유 process의 종료를 확인한 뒤 v3로 교체합니다.
        if (this.#processExists(existing.pid)) {
          await this.#terminate(existing);
          await sanitizeLocalBootstrapCapability(this.#paths, bootstrapBinding(existing), this.#beforeBootstrapCleanup);
        } else {
          await rm(this.#paths.pidFile, { force: true });
          await sanitizeLocalBootstrapCapability(this.#paths, bootstrapBinding(existing), this.#beforeBootstrapCleanup);
        }
      } else if (this.#processExists(existing.pid)) {
        throw new Error("기록된 PID가 Massion server가 아니므로 덮어쓰지 않습니다");
      } else {
        await rm(this.#paths.pidFile, { force: true });
        await sanitizeLocalBootstrapCapability(this.#paths, bootstrapBinding(existing), this.#beforeBootstrapCleanup);
      }
    }
    await Promise.all([access(this.#nodeExecutable, constants.X_OK), access(this.#serverScript, constants.R_OK)]);
    const localPort = port(this.#environment);
    const endpoint = `http://127.0.0.1:${String(localPort)}`;
    const surrealRuntime = await this.#localSurrealRuntime();
    const database = await surrealRuntime.start();
    const startedSidecar = database.status === "started";
    let child: SpawnedProcess | undefined;
    let record: LocalPidRecordV3 | undefined;
    try {
      const bootstrap = await createLocalBootstrapCapability(this.#paths, this.#beforeBootstrapCreateFailureCleanup);
      this.#holdBootstrapCapability(bootstrap);
      const logDescriptor = openSync(this.#paths.logFile, "a", 0o600);
      try {
        child = this.#spawnProcess(this.#nodeExecutable, [this.#serverScript], {
          cwd: this.#paths.dataDirectory,
          env: this.#serverEnvironment(database.endpoint, bootstrap.path),
          stdout: logDescriptor,
          stderr: logDescriptor,
        });
        child.unref();
      } finally {
        closeSync(logDescriptor);
      }
      if (!child.pid) throw new Error("local Massion server PID를 받지 못했습니다");
      record = {
        schema: "massion.local-process.v3",
        pid: child.pid,
        endpoint,
        nodeExecutable: this.#nodeExecutable,
        serverScript: this.#serverScript,
        runtimeVersion: this.#runtimeVersion,
        bootstrapCapabilityFile: bootstrap.path,
        bootstrapCapabilityDevice: bootstrap.device,
        bootstrapCapabilityInode: bootstrap.inode,
        startedAt: new Date().toISOString(),
      };
      await writePidRecord(this.#paths.pidFile, record);
      const readyDeadline = performance.now() + LOCAL_DAEMON_READY_TIMEOUT_MS;
      for (
        let attempt = 0;
        attempt < LOCAL_DAEMON_READY_MAX_ATTEMPTS && performance.now() < readyDeadline;
        attempt += 1
      ) {
        if (await this.#ready(endpoint)) return { status: "started", pid: child.pid, endpoint };
        if (!this.#processExists(child.pid)) break;
        await this.#wait(LOCAL_DAEMON_READY_POLL_MS);
      }
      throw new Error(`local Massion server가 준비되지 않았습니다. log: ${this.#paths.logFile}`);
    } catch (error) {
      if (record && this.#processExists(record.pid) && (await this.#owned(record))) await this.#terminate(record);
      else await rm(this.#paths.pidFile, { force: true });
      this.discardBootstrapCapability();
      await sanitizeLocalBootstrapCapability(
        this.#paths,
        this.#bootstrapCapabilityBinding,
        this.#beforeBootstrapCleanup,
      );
      this.#bootstrapCapabilityBinding = undefined;
      if (startedSidecar) await surrealRuntime.stop().catch(() => undefined);
      throw error;
    }
  }

  async status(): Promise<{
    readonly status: "stopped" | "starting" | "ready" | "foreign";
    readonly pid?: number;
    readonly endpoint?: string;
  }> {
    const record = await readPidRecord(this.#paths.pidFile);
    if (!record || !this.#processExists(record.pid)) return { status: "stopped" };
    if (!this.#current(record) || !(await this.#owned(record)))
      return { status: "foreign", pid: record.pid, endpoint: record.endpoint };
    return {
      status: (await this.#ready(record.endpoint)) ? "ready" : "starting",
      pid: record.pid,
      endpoint: record.endpoint,
    };
  }

  async stop(): Promise<{ readonly status: "stopped" | "already-stopped"; readonly pid?: number }> {
    const record = await readPidRecord(this.#paths.pidFile);
    if (record && this.#processExists(record.pid) && !(await this.#owned(record)))
      throw new Error("기록된 PID는 Massion server가 아닙니다");
    const surrealRuntime = await this.#localSurrealRuntime();
    if (!record) {
      this.discardBootstrapCapability();
      await sanitizeLocalBootstrapCapability(
        this.#paths,
        this.#bootstrapCapabilityBinding,
        this.#beforeBootstrapCleanup,
      );
      this.#bootstrapCapabilityBinding = undefined;
      await surrealRuntime.stop();
      return { status: "already-stopped" };
    }
    if (!this.#processExists(record.pid)) {
      await rm(this.#paths.pidFile, { force: true });
      this.discardBootstrapCapability();
      await sanitizeLocalBootstrapCapability(
        this.#paths,
        bootstrapBinding(record) ?? this.#bootstrapCapabilityBinding,
        this.#beforeBootstrapCleanup,
      );
      this.#bootstrapCapabilityBinding = undefined;
      await surrealRuntime.stop();
      return { status: "already-stopped", pid: record.pid };
    }
    await this.#terminate(record);
    this.discardBootstrapCapability();
    await sanitizeLocalBootstrapCapability(this.#paths, this.#bootstrapCapabilityBinding, this.#beforeBootstrapCleanup);
    this.#bootstrapCapabilityBinding = undefined;
    await surrealRuntime.stop();
    return { status: "stopped", pid: record.pid };
  }

  async backup(path?: string): Promise<{ readonly status: "backed-up"; readonly path: string }> {
    const destination =
      path ?? join(this.#paths.backupDirectory, `massion-${new Date().toISOString().replaceAll(/[:.]/gu, "")}.json`);
    if (!isAbsolute(destination)) throw new Error("backup path는 절대 경로여야 합니다");
    await ensureLocalDataEpoch(this.#paths);
    const previous = await this.status();
    if (previous.status === "foreign") throw new Error("foreign process 상태에서는 backup할 수 없습니다");
    if (previous.status === "ready" || previous.status === "starting") await this.stop();
    await Promise.all([
      ensureLocalTokenKey(this.#paths),
      ensureLocalCredentialKey(this.#paths),
      ensureLocalDatabasePassword(this.#paths),
    ]);
    const surrealRuntime = await this.#localSurrealRuntime();
    const database = await surrealRuntime.start();
    const startedSidecar = database.status === "started";
    try {
      const code = await new Promise<number | null>((resolveCode, reject) => {
        const child = spawn(this.#nodeExecutable, [this.#serverScript, "backup", destination], {
          cwd: this.#paths.dataDirectory,
          env: this.#serverEnvironment(database.endpoint),
          stdio: ["ignore", "ignore", "inherit"],
        });
        child.once("error", reject);
        child.once("close", resolveCode);
      });
      if (code !== 0) throw new Error("local backup이 실패했습니다");
    } finally {
      if (previous.status === "ready" || previous.status === "starting") await this.start();
      else if (startedSidecar) await surrealRuntime.stop();
    }
    return { status: "backed-up", path: destination };
  }
}
