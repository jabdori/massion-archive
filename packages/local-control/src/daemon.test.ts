import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ensureLocalDataEpoch,
  LOCAL_BOOTSTRAP_CAPABILITY_TTL_MS,
  LocalDaemonManager,
  resolveLocalPaths,
  resolveLocalSurrealRuntime,
} from "./daemon.js";

const epochRace = vi.hoisted(() => ({ configDirectory: "", dataFile: "", configReads: 0 }));
const cryptoBuffers = vi.hoisted(() => ({ values: [] as Buffer[] }));
const lockFailure = vi.hoisted(() => ({
  stage: undefined as "writeFile" | "sync" | "close" | undefined,
  failed: false,
}));
const capabilityFailure = vi.hoisted(() => ({
  stage: undefined as "writeFile" | "sync" | undefined,
  partialBytes: 16,
  failed: false,
}));

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("테스트 port를 확인하지 못했습니다");
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readdir = async (file: unknown, options?: unknown) => {
    const entries = await (actual.readdir as (path: unknown, options?: unknown) => Promise<unknown>)(file, options);
    if (epochRace.dataFile && file === epochRace.configDirectory && epochRace.configReads++ === 1) {
      await (actual.writeFile as (...arguments_: unknown[]) => Promise<void>)(epochRace.dataFile, "late data", {
        mode: 0o600,
        flag: "wx",
      });
    }
    return entries;
  };
  const open = async (...arguments_: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...arguments_);
    const [path, flags] = arguments_;
    if (typeof path !== "string" || typeof flags !== "number") return handle;
    const startLock = path.endsWith("server.start.lock") && lockFailure.stage !== undefined;
    const bootstrapCapability = path.endsWith(".cap") && capabilityFailure.stage !== undefined;
    if (!startLock && !bootstrapCapability) return handle;
    return new Proxy(handle, {
      get(target, property) {
        const value = Reflect.get(target, property) as unknown;
        if (startLock && property === lockFailure.stage && typeof value === "function") {
          return async (...methodArguments: unknown[]) => {
            if (!lockFailure.failed) {
              lockFailure.failed = true;
              if (property === "close") await target.close();
              throw new Error(`start lock ${String(property)} failed`);
            }
            return await Reflect.apply(value, target, methodArguments);
          };
        }
        if (bootstrapCapability && property === capabilityFailure.stage && typeof value === "function") {
          return async (...methodArguments: unknown[]) => {
            if (!capabilityFailure.failed) {
              capabilityFailure.failed = true;
              if (property === "writeFile") {
                const bytes = methodArguments[0];
                if (Buffer.isBuffer(bytes)) await target.writeFile(bytes.subarray(0, capabilityFailure.partialBytes));
              }
              throw new Error(`bootstrap capability ${String(property)} failed`);
            }
            return await Reflect.apply(value, target, methodArguments);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  return { ...actual, default: actual, open: open as typeof actual.open, readdir: readdir as typeof actual.readdir };
});

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomBytes(size: number) {
      const value = actual.randomBytes(size);
      cryptoBuffers.values.push(value);
      return value;
    },
  };
});

describe("공용 local daemon 제어", () => {
  const roots: string[] = [];

  afterEach(async () => {
    epochRace.configDirectory = "";
    epochRace.dataFile = "";
    epochRace.configReads = 0;
    for (const value of cryptoBuffers.values) value.fill(0);
    cryptoBuffers.values.length = 0;
    lockFailure.stage = undefined;
    lockFailure.failed = false;
    capabilityFailure.stage = undefined;
    capabilityFailure.partialBytes = 16;
    capabilityFailure.failed = false;
    vi.useRealTimers();
    await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
  });

  it("v1 전용 root를 사용하고 이전 legacy root는 재사용하거나 변경하지 않는다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-control-v1-root-"));
    roots.push(root);
    const legacy = join(root, ".local", "share", "massion", "surrealdb", "3", "database", "legacy.db");
    await mkdir(join(legacy, ".."), { recursive: true, mode: 0o700 });
    await writeFile(legacy, "legacy data", { mode: 0o600 });

    const paths = resolveLocalPaths({ HOME: root });

    expect(paths.dataDirectory).toBe(join(root, ".local", "share", "massion-v1"));
    expect(paths.configDirectory).toBe(join(root, ".config", "massion-v1"));
    expect(paths.stateDirectory).toBe(join(root, ".local", "state", "massion-v1"));
    expect(resolveLocalSurrealRuntime({ home: root }).dataDirectory).toBe(
      join(root, ".local", "share", "massion-v1", "surrealdb", "3", "database"),
    );
    await ensureLocalDataEpoch(paths);

    expect(await readFile(legacy, "utf8")).toBe("legacy data");
    await expect(stat(paths.epochFile)).resolves.toMatchObject({ isFile: expect.any(Function) });
  });

  it("실행 중일 수 있는 SurrealDB runtime을 제자리 덮어쓰지 않는다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-control-runtime-replace-"));
    roots.push(root);
    const environment = {
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"),
      MASSION_SERVER_BIN: join(root, "server.js"),
      MASSION_LOCAL_PORT: "17331",
      MASSION_SURREAL_PORT: "17330",
    };
    const paths = resolveLocalPaths(environment);
    await ensureLocalDataEpoch(paths);
    const runtime = resolveLocalSurrealRuntime({ home: root, xdgDataHome: environment.XDG_DATA_HOME });
    const source = join(root, "surreal-source");
    const sourceBytes = Buffer.from("#!/bin/sh\nprintf 'invalid version\\n'\n");
    const observer = join(root, "installed-runtime-observer");
    await Promise.all([
      writeFile(environment.MASSION_SERVER_BIN, "", { mode: 0o600 }),
      writeFile(source, sourceBytes, { mode: 0o700 }),
      mkdir(join(runtime.binaryPath, ".."), { recursive: true, mode: 0o700 }),
    ]);
    await writeFile(runtime.binaryPath, "installed-runtime", { mode: 0o700 });
    await link(runtime.binaryPath, observer);
    const manager = new LocalDaemonManager({
      environment: {
        ...environment,
        MASSION_SURREAL_BINARY: source,
        MASSION_SURREAL_SHA256: createHash("sha256").update(sourceBytes).digest("hex"),
      },
    });

    await expect(manager.start()).rejects.toThrow(/version 3\.2\.1/u);

    await expect(readFile(observer, "utf8")).resolves.toBe("installed-runtime");
    await expect(readFile(runtime.binaryPath)).resolves.toEqual(sourceBytes);
  });

  it("호환 불명 epoch의 data-bearing root를 보존하고 migration을 요구한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-control-v1-epoch-"));
    roots.push(root);
    const paths = resolveLocalPaths({ HOME: root });
    await Promise.all(
      [paths.configDirectory, paths.dataDirectory, paths.stateDirectory].map(async (directory) => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(join(directory, "stale"), "stale", { mode: 0o600 });
        await writeFile(join(directory, ".massion-data-epoch"), "obsolete\n", { mode: 0o600 });
      }),
    );

    await expect(ensureLocalDataEpoch(paths)).rejects.toMatchObject({
      name: "LocalDataEpochMigrationRequiredError",
    });
    await expect(readFile(join(paths.dataDirectory, "stale"), "utf8")).resolves.toBe("stale");
    await expect(readFile(join(paths.configDirectory, ".massion-data-epoch"), "utf8")).resolves.toBe("obsolete\n");
  });

  it("marker 기록 전 재검사에서 새 data-bearing root가 생기면 migration을 요구한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-control-v1-epoch-race-"));
    roots.push(root);
    const paths = resolveLocalPaths({ HOME: root });
    await Promise.all(
      [paths.configDirectory, paths.dataDirectory, paths.stateDirectory].map(
        async (directory) => await mkdir(directory, { recursive: true, mode: 0o700 }),
      ),
    );
    const lateData = join(paths.dataDirectory, "late-data");
    epochRace.configDirectory = paths.configDirectory;
    epochRace.dataFile = lateData;

    await expect(ensureLocalDataEpoch(paths)).rejects.toMatchObject({
      name: "LocalDataEpochMigrationRequiredError",
    });
    await expect(readFile(lateData, "utf8")).resolves.toBe("late data");
    await expect(readFile(join(paths.configDirectory, ".massion-data-epoch"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("새 root에 현재 data epoch marker를 기록한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-control-v1-new-epoch-"));
    roots.push(root);
    const paths = resolveLocalPaths({ HOME: root });

    await ensureLocalDataEpoch(paths);

    await Promise.all(
      [paths.configDirectory, paths.dataDirectory, paths.stateDirectory].map(async (directory) => {
        await expect(readFile(join(directory, ".massion-data-epoch"), "utf8")).resolves.toBe(
          "massion-v1-data-epoch-1\n",
        );
        expect((await stat(directory)).mode & 0o077).toBe(0);
      }),
    );
  });

  it("marker가 없는 빈 root는 삭제하지 않고 marker만 기록한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-control-v1-empty-epoch-"));
    roots.push(root);
    const paths = resolveLocalPaths({ HOME: root });
    const directories = [paths.configDirectory, paths.dataDirectory, paths.stateDirectory];
    await Promise.all(directories.map(async (directory) => await mkdir(directory, { recursive: true, mode: 0o700 })));
    const inodes = await Promise.all(directories.map(async (directory) => (await stat(directory)).ino));

    await expect(ensureLocalDataEpoch(paths)).resolves.toBeUndefined();

    await Promise.all(
      directories.map(async (directory, index) => {
        expect((await stat(directory)).ino).toBe(inodes[index]);
        await expect(readFile(join(directory, ".massion-data-epoch"), "utf8")).resolves.toBe(
          "massion-v1-data-epoch-1\n",
        );
      }),
    );
  });

  it("주입된 Node·server script·runtime version과 인스턴스 capability 경로를 PID schema v3에 기록한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-control-"));
    roots.push(root);
    const nodeExecutable = join(root, "node");
    const serverScript = join(root, "server.js");
    await Promise.all([writeFile(nodeExecutable, "", { mode: 0o700 }), writeFile(serverScript, "", { mode: 0o600 })]);
    const spawnProcess = vi.fn(() => ({ pid: 42, unref() {} }));
    const bundledExtensionsRoot = join(root, "extensions");
    const manager = new LocalDaemonManager({
      environment: { HOME: root, MASSION_REGISTRY_BUNDLED_EXTENSIONS: bundledExtensionsRoot },
      nodeExecutable,
      serverScript,
      runtimeVersion: "2.4.0",
      fetcher: async () => Response.json({ status: "ready" }),
      processExists: () => true,
      processCommand: async () => `${nodeExecutable} ${serverScript}`,
      spawnProcess,
      surrealRuntime: {
        start: async () => ({ status: "already-running", pid: 41, endpoint: "http://127.0.0.1:7330" }),
        stop: async () => ({ status: "stopped", pid: 41 }),
      },
    });

    const started = await manager.start();
    expect(started).toMatchObject({ status: "started", pid: 42 });
    expect(spawnProcess).toHaveBeenCalledWith(nodeExecutable, [serverScript], expect.any(Object));
    const serverEnvironment = spawnProcess.mock.calls[0]?.[2].env;
    expect(serverEnvironment.MASSION_REGISTRY_BUNDLED_EXTENSIONS).toBe(bundledExtensionsRoot);
    expect(serverEnvironment.MASSION_REGISTRY_ARTIFACT_ROOT).toBe(
      join(resolveLocalPaths({ HOME: root }).dataDirectory, "registry"),
    );
    const capabilityPath = serverEnvironment.MASSION_BOOTSTRAP_CAPABILITY_FILE;
    expect(typeof capabilityPath).toBe("string");
    const capabilityBytes = await readFile(String(capabilityPath));
    expect(capabilityBytes).toHaveLength(32);
    const capability = capabilityBytes.toString("base64url");
    const ownedCopy = cryptoBuffers.values.find((value) => value.length === 32 && value.equals(capabilityBytes));
    expect((await stat(String(capabilityPath))).mode & 0o777).toBe(0o600);
    expect(serverEnvironment).not.toHaveProperty("MASSION_BOOTSTRAP_CAPABILITY");
    expect(JSON.stringify(started)).not.toContain(capability);
    expect(manager.takeBootstrapCapability()).toBe(capability);
    expect(ownedCopy).toEqual(Buffer.alloc(32));
    expect(manager.takeBootstrapCapability()).toBeUndefined();
    const state = JSON.parse(await readFile(resolveLocalPaths({ HOME: root }).pidFile, "utf8")) as Record<
      string,
      unknown
    >;
    expect(state).toMatchObject({
      schema: "massion.local-process.v3",
      nodeExecutable,
      serverScript,
      runtimeVersion: "2.4.0",
      bootstrapCapabilityFile: capabilityPath,
    });
    expect((await stat(resolveLocalPaths({ HOME: root }).pidFile)).mode & 0o777).toBe(0o600);
  });

  it("기존 60초 polling 경계를 넘긴 소유 server의 migration 완료를 기다린다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-control-slow-start-"));
    roots.push(root);
    const nodeExecutable = join(root, "node");
    const serverScript = join(root, "server.js");
    await Promise.all([writeFile(nodeExecutable, "", { mode: 0o700 }), writeFile(serverScript, "", { mode: 0o600 })]);
    let readinessChecks = 0;
    const signal = vi.fn();
    const manager = new LocalDaemonManager({
      environment: { HOME: root },
      nodeExecutable,
      serverScript,
      fetcher: async () => Response.json({ status: (readinessChecks += 1) === 241 ? "ready" : "starting" }),
      processExists: () => true,
      processCommand: async () => `${nodeExecutable} ${serverScript}`,
      signal,
      wait: async () => undefined,
      spawnProcess: () => ({ pid: 42, unref() {} }),
      surrealRuntime: {
        start: async () => ({ status: "already-running", pid: 41, endpoint: "http://127.0.0.1:7330" }),
        stop: async () => ({ status: "stopped", pid: 41 }),
      },
    });

    await expect(manager.start()).resolves.toMatchObject({ status: "started", pid: 42 });
    expect(readinessChecks).toBe(241);
    expect(signal).not.toHaveBeenCalled();
  });

  it("사용하지 않은 manager capability 메모리를 발급 TTL 뒤 자동 zeroize한다", async () => {
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const root = await mkdtemp(join(tmpdir(), "massion-local-control-capability-ttl-"));
    roots.push(root);
    const nodeExecutable = join(root, "node");
    const serverScript = join(root, "server.js");
    await Promise.all([writeFile(nodeExecutable, "", { mode: 0o700 }), writeFile(serverScript, "", { mode: 0o600 })]);
    const manager = new LocalDaemonManager({
      environment: { HOME: root },
      nodeExecutable,
      serverScript,
      fetcher: async () => Response.json({ status: "ready" }),
      processExists: () => true,
      processCommand: async () => `${nodeExecutable} ${serverScript}`,
      spawnProcess: () => ({ pid: 42, unref() {} }),
      surrealRuntime: {
        start: async () => ({ status: "already-running", pid: 41, endpoint: "http://127.0.0.1:7330" }),
        stop: async () => ({ status: "stopped", pid: 41 }),
      },
    });

    await manager.start();
    const state = JSON.parse(await readFile(resolveLocalPaths({ HOME: root }).pidFile, "utf8")) as {
      bootstrapCapabilityFile: string;
    };
    const fileBytes = await readFile(state.bootstrapCapabilityFile);
    const ownedCopy = cryptoBuffers.values.find((value) => value.length === 32 && value.equals(fileBytes));
    expect(ownedCopy).toBeDefined();

    await vi.advanceTimersByTimeAsync(LOCAL_BOOTSTRAP_CAPABILITY_TTL_MS + 1);

    expect(manager.takeBootstrapCapability()).toBeUndefined();
    expect(ownedCopy).toEqual(Buffer.alloc(32));
  });

  it("명시적 discard와 TTL timer 경합이 idempotent하게 manager capability를 zeroize한다", async () => {
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const root = await mkdtemp(join(tmpdir(), "massion-local-control-capability-discard-"));
    roots.push(root);
    const nodeExecutable = join(root, "node");
    const serverScript = join(root, "server.js");
    await Promise.all([writeFile(nodeExecutable, "", { mode: 0o700 }), writeFile(serverScript, "", { mode: 0o600 })]);
    const manager = new LocalDaemonManager({
      environment: { HOME: root },
      nodeExecutable,
      serverScript,
      fetcher: async () => Response.json({ status: "ready" }),
      processExists: () => true,
      processCommand: async () => `${nodeExecutable} ${serverScript}`,
      spawnProcess: () => ({ pid: 42, unref() {} }),
      surrealRuntime: {
        start: async () => ({ status: "already-running", pid: 41, endpoint: "http://127.0.0.1:7330" }),
        stop: async () => ({ status: "stopped", pid: 41 }),
      },
    });

    await manager.start();
    const state = JSON.parse(await readFile(resolveLocalPaths({ HOME: root }).pidFile, "utf8")) as {
      bootstrapCapabilityFile: string;
    };
    const fileBytes = await readFile(state.bootstrapCapabilityFile);
    const ownedCopy = cryptoBuffers.values.find((value) => value.length === 32 && value.equals(fileBytes));

    manager.discardBootstrapCapability();
    manager.discardBootstrapCapability();
    await vi.advanceTimersByTimeAsync(LOCAL_BOOTSTRAP_CAPABILITY_TTL_MS + 1);

    expect(manager.takeBootstrapCapability()).toBeUndefined();
    expect(ownedCopy).toEqual(Buffer.alloc(32));
  });

  it("daemon spawn 오류에서도 manager capability 복사를 zeroize한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-control-capability-error-"));
    roots.push(root);
    const nodeExecutable = join(root, "node");
    const serverScript = join(root, "server.js");
    await Promise.all([writeFile(nodeExecutable, "", { mode: 0o700 }), writeFile(serverScript, "", { mode: 0o600 })]);
    const manager = new LocalDaemonManager({
      environment: { HOME: root },
      nodeExecutable,
      serverScript,
      fetcher: async () => Response.json({ status: "ready" }),
      processExists: () => false,
      processCommand: async () => `${nodeExecutable} ${serverScript}`,
      spawnProcess: () => {
        throw new Error("spawn failed");
      },
      surrealRuntime: {
        start: async () => ({ status: "already-running", pid: 41, endpoint: "http://127.0.0.1:7330" }),
        stop: async () => ({ status: "stopped", pid: 41 }),
      },
    });

    await expect(manager.start()).rejects.toThrow("spawn failed");
    expect(cryptoBuffers.values.at(-1)).toEqual(Buffer.alloc(32));
    expect(manager.takeBootstrapCapability()).toBeUndefined();
  });

  it.each([
    ["writeFile 1 byte", "writeFile", 1],
    ["writeFile 15 byte", "writeFile", 15],
    ["writeFile 16 byte", "writeFile", 16],
    ["writeFile 17 byte", "writeFile", 17],
    ["writeFile 31 byte", "writeFile", 31],
    ["sync 32 byte", "sync", 32],
  ] as const)("bootstrap capability 생성 %s 실패를 열린 fd로 비파괴 폐기한다", async (_label, stage, partialBytes) => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-control-capability-create-failure-"));
    roots.push(root);
    const nodeExecutable = join(root, "node");
    const serverScript = join(root, "server.js");
    await Promise.all([writeFile(nodeExecutable, "", { mode: 0o700 }), writeFile(serverScript, "", { mode: 0o600 })]);
    capabilityFailure.stage = stage;
    capabilityFailure.partialBytes = partialBytes;
    const manager = new LocalDaemonManager({
      environment: { HOME: root },
      nodeExecutable,
      serverScript,
      fetcher: async () => Response.json({ status: "ready" }),
      processExists: () => false,
      processCommand: async () => `${nodeExecutable} ${serverScript}`,
      spawnProcess: () => ({ pid: 42, unref() {} }),
      surrealRuntime: {
        start: async () => ({ status: "already-running", pid: 41, endpoint: "http://127.0.0.1:7330" }),
        stop: async () => ({ status: "stopped", pid: 41 }),
      },
    });

    await expect(manager.start()).rejects.toThrow(`bootstrap capability ${stage} failed`);

    const paths = resolveLocalPaths({ HOME: root });
    const files = (await readdir(paths.bootstrapDirectory)).filter((entry) => entry.endsWith(".cap"));
    expect(files).toHaveLength(1);
    const capabilityFile = files[0];
    if (!capabilityFile) throw new Error("bootstrap capability 파일이 없습니다");
    const metadata = await stat(join(paths.bootstrapDirectory, capabilityFile));
    expect(metadata).toMatchObject({ size: 0 });
    expect(metadata.mode & 0o777).toBe(0o600);
    expect(cryptoBuffers.values.at(-1)).toEqual(Buffer.alloc(32));
  });

  it("bootstrap capability 생성 실패 cleanup은 같은 inode의 33 byte 교체를 fail-closed한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-control-capability-create-oversize-"));
    roots.push(root);
    const nodeExecutable = join(root, "node");
    const serverScript = join(root, "server.js");
    await Promise.all([writeFile(nodeExecutable, "", { mode: 0o700 }), writeFile(serverScript, "", { mode: 0o600 })]);
    capabilityFailure.stage = "writeFile";
    capabilityFailure.partialBytes = 16;
    let enteredCleanup: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredCleanup = resolve;
    });
    let releaseCleanup: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const manager = new LocalDaemonManager({
      environment: { HOME: root },
      nodeExecutable,
      serverScript,
      fetcher: async () => Response.json({ status: "ready" }),
      processExists: () => false,
      processCommand: async () => `${nodeExecutable} ${serverScript}`,
      spawnProcess: () => ({ pid: 42, unref() {} }),
      beforeBootstrapCreateFailureCleanup: async () => {
        enteredCleanup?.();
        await release;
      },
      surrealRuntime: {
        start: async () => ({ status: "already-running", pid: 41, endpoint: "http://127.0.0.1:7330" }),
        stop: async () => ({ status: "stopped", pid: 41 }),
      },
    });

    const starting = manager.start();
    void starting.catch(() => undefined);
    const reached = await Promise.race([entered.then(() => true), delay(100).then(() => false)]);
    if (!reached) {
      await expect(starting).rejects.toThrow("writeFile failed");
      expect(reached).toBe(true);
      return;
    }
    const paths = resolveLocalPaths({ HOME: root });
    const capabilityFile = (await readdir(paths.bootstrapDirectory)).find((entry) => entry.endsWith(".cap"));
    if (!capabilityFile) throw new Error("bootstrap capability 파일이 없습니다");
    const capabilityPath = join(paths.bootstrapDirectory, capabilityFile);
    await writeFile(capabilityPath, Buffer.alloc(33, 51));
    releaseCleanup?.();

    await expect(starting).rejects.toThrow("capability cleanup failed");
    expect(await readFile(capabilityPath)).toEqual(Buffer.alloc(33, 51));
  });

  it.each(["replacement", "symlink", "hardlink"] as const)(
    "만료 capability의 %s barrier race가 다른 inode나 경로를 변경·삭제하지 않는다",
    async (race) => {
      const root = await mkdtemp(join(tmpdir(), "massion-local-control-capability-expiry-race-"));
      roots.push(root);
      const nodeExecutable = join(root, "node");
      const serverScript = join(root, "server.js");
      await Promise.all([writeFile(nodeExecutable, "", { mode: 0o700 }), writeFile(serverScript, "", { mode: 0o600 })]);
      const baseDependencies = {
        environment: { HOME: root },
        nodeExecutable,
        serverScript,
        fetcher: async () => Response.json({ status: "ready" }),
        processExists: () => true,
        processCommand: async () => `${nodeExecutable} ${serverScript}`,
        spawnProcess: () => ({ pid: 42, unref() {} }),
        surrealRuntime: {
          start: async () => ({ status: "already-running" as const, pid: 41, endpoint: "http://127.0.0.1:7330" }),
          stop: async () => ({ status: "stopped" as const, pid: 41 }),
        },
      };
      const owner = new LocalDaemonManager(baseDependencies);
      await owner.initializeStateForTest({ pid: 41, endpoint: "http://127.0.0.1:7331" });
      owner.discardBootstrapCapability();
      const paths = resolveLocalPaths({ HOME: root });
      const state = JSON.parse(await readFile(paths.pidFile, "utf8")) as { bootstrapCapabilityFile: string };
      const capabilityPath = state.bootstrapCapabilityFile;
      const expired = (Date.now() - LOCAL_BOOTSTRAP_CAPABILITY_TTL_MS - 1_000) / 1_000;
      await utimes(capabilityPath, expired, expired);
      let enteredCleanup: (() => void) | undefined;
      const entered = new Promise<void>((resolve) => {
        enteredCleanup = resolve;
      });
      let releaseCleanup: (() => void) | undefined;
      const release = new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });
      const manager = new LocalDaemonManager({
        ...baseDependencies,
        beforeBootstrapCleanup: async () => {
          enteredCleanup?.();
          await release;
        },
      });

      const starting = manager.start();
      const reached = await Promise.race([entered.then(() => true), delay(100).then(() => false)]);
      if (!reached) {
        await starting;
        expect(reached).toBe(true);
        return;
      }
      const movedPath = join(paths.bootstrapDirectory, "expired-original.cap");
      const targetPath = join(paths.bootstrapDirectory, "expiry-target.cap");
      if (race === "replacement") {
        await rename(capabilityPath, movedPath);
        await writeFile(capabilityPath, Buffer.alloc(32, 41), { mode: 0o600, flag: "wx" });
      } else if (race === "symlink") {
        await rename(capabilityPath, movedPath);
        await writeFile(targetPath, Buffer.alloc(32, 42), { mode: 0o600, flag: "wx" });
        await symlink(targetPath, capabilityPath);
      } else {
        await link(capabilityPath, movedPath);
      }
      releaseCleanup?.();

      if (race === "hardlink") {
        await expect(starting).rejects.toThrow("신뢰 검증");
        expect(await readFile(capabilityPath)).toHaveLength(32);
        expect(await readFile(movedPath)).toHaveLength(32);
      } else {
        await expect(starting).resolves.toMatchObject({ status: "already-running" });
        expect(await readFile(capabilityPath)).toEqual(Buffer.alloc(32, race === "replacement" ? 41 : 42));
        await expect(stat(movedPath)).resolves.toMatchObject({ size: 0 });
      }
    },
  );

  it("server process를 다시 시작할 때 이전 bootstrap capability를 재사용하지 않는다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-control-bootstrap-restart-"));
    roots.push(root);
    const nodeExecutable = join(root, "node");
    const serverScript = join(root, "server.js");
    await Promise.all([writeFile(nodeExecutable, "", { mode: 0o700 }), writeFile(serverScript, "", { mode: 0o600 })]);
    let firstAlive = true;
    const manager = (pid: number) =>
      new LocalDaemonManager({
        environment: { HOME: root },
        nodeExecutable,
        serverScript,
        runtimeVersion: "2.4.0",
        fetcher: async () => Response.json({ status: "ready" }),
        processExists: (candidate) => (candidate === 42 ? firstAlive : true),
        processCommand: async () => `${nodeExecutable} ${serverScript}`,
        spawnProcess: () => ({ pid, unref() {} }),
        surrealRuntime: {
          start: async () => ({ status: "already-running", pid: 41, endpoint: "http://127.0.0.1:7330" }),
          stop: async () => ({ status: "stopped", pid: 41 }),
        },
      });

    const first = manager(42);
    await first.start();
    const firstCapability = first.takeBootstrapCapability();
    firstAlive = false;
    const restarted = manager(43);
    await restarted.start();
    const restartedCapability = restarted.takeBootstrapCapability();

    expect(firstCapability).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(restartedCapability).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(restartedCapability).not.toBe(firstCapability);
  });

  it("CLI와 desktop이 동시에 실제 child를 시작해도 한 process와 한 인스턴스 capability만 소유한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-control-concurrent-child-"));
    roots.push(root);
    const localPort = await unusedPort();
    const surrealPort = await unusedPort();
    const serverScript = fileURLToPath(new URL("./fixtures/local-daemon-child.mjs", import.meta.url));
    const environment = {
      HOME: root,
      MASSION_LOCAL_PORT: String(localPort),
      MASSION_SURREAL_PORT: String(surrealPort),
    };
    const surrealRuntime = {
      start: async () => ({
        status: "already-running" as const,
        pid: process.pid,
        endpoint: `http://127.0.0.1:${String(surrealPort)}`,
      }),
      stop: async () => ({ status: "already-stopped" as const }),
    };
    const cliManager = new LocalDaemonManager({ environment, serverScript, surrealRuntime });
    const desktopManager = new LocalDaemonManager({ environment, serverScript, surrealRuntime });
    let childPid: number | undefined;
    try {
      const results = await Promise.all([cliManager.start(), desktopManager.start()]);
      expect(results.map(({ status }) => status).sort()).toEqual(["already-running", "started"]);
      expect(new Set(results.map(({ pid }) => pid)).size).toBe(1);
      childPid = results[0]?.pid;

      const paths = resolveLocalPaths(environment);
      const state = JSON.parse(await readFile(paths.pidFile, "utf8")) as Record<string, unknown>;
      expect(state.schema).toBe("massion.local-process.v3");
      const capabilityPath = String(state.bootstrapCapabilityFile);
      expect(capabilityPath.startsWith(`${paths.bootstrapDirectory}/`)).toBe(true);
      expect(await readdir(paths.bootstrapDirectory)).toEqual([capabilityPath.split("/").at(-1)]);
      const capabilityBytes = await readFile(capabilityPath);
      expect(capabilityBytes).toHaveLength(32);
      expect(cliManager.takeBootstrapCapability()).toBe(capabilityBytes.toString("base64url"));
      expect(desktopManager.takeBootstrapCapability()).toBe(capabilityBytes.toString("base64url"));
    } finally {
      const pid = childPid;
      if (pid !== undefined) {
        await cliManager.stop().catch(() => {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // 이미 종료된 test child입니다.
          }
        });
      }
    }
  }, 20_000);

  it.each(["replacement", "symlink", "hardlink"] as const)(
    "manager cleanup의 %s barrier race가 다른 파일을 변경하거나 삭제하지 않는다",
    async (race) => {
      const root = await mkdtemp(join(tmpdir(), "massion-local-control-cleanup-race-"));
      roots.push(root);
      const nodeExecutable = join(root, "node");
      const serverScript = join(root, "server.js");
      await Promise.all([writeFile(nodeExecutable, "", { mode: 0o700 }), writeFile(serverScript, "", { mode: 0o600 })]);
      let enteredCleanup: (() => void) | undefined;
      const entered = new Promise<void>((resolve) => {
        enteredCleanup = resolve;
      });
      let releaseCleanup: (() => void) | undefined;
      const release = new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });
      let alive = true;
      const manager = new LocalDaemonManager({
        environment: { HOME: root },
        nodeExecutable,
        serverScript,
        fetcher: async () => Response.json({ status: "ready" }),
        processExists: () => alive,
        processCommand: async () => `${nodeExecutable} ${serverScript}`,
        signal: () => {
          alive = false;
        },
        wait: async () => undefined,
        spawnProcess: () => ({ pid: 42, unref() {} }),
        beforeBootstrapCleanup: async () => {
          enteredCleanup?.();
          await release;
        },
        surrealRuntime: {
          start: async () => ({ status: "already-running", pid: 41, endpoint: "http://127.0.0.1:7330" }),
          stop: async () => ({ status: "stopped", pid: 41 }),
        },
      });
      await manager.start();
      const paths = resolveLocalPaths({ HOME: root });
      const state = JSON.parse(await readFile(paths.pidFile, "utf8")) as { bootstrapCapabilityFile: string };
      const capabilityPath = state.bootstrapCapabilityFile;
      const movedPath = join(paths.bootstrapDirectory, "moved.cap");
      const targetPath = join(paths.bootstrapDirectory, "target.cap");

      const stopping = manager.stop();
      await entered;
      if (race === "replacement") {
        await rename(capabilityPath, movedPath);
        await writeFile(capabilityPath, Buffer.alloc(32, 31), { mode: 0o600, flag: "wx" });
      } else if (race === "symlink") {
        await rename(capabilityPath, movedPath);
        await writeFile(targetPath, Buffer.alloc(32, 32), { mode: 0o600, flag: "wx" });
        await symlink(targetPath, capabilityPath);
      } else {
        await link(capabilityPath, movedPath);
      }
      releaseCleanup?.();

      if (race === "hardlink") {
        await expect(stopping).rejects.toThrow("cleanup 신뢰");
        expect(await readFile(capabilityPath)).toHaveLength(32);
        expect(await readFile(movedPath)).toHaveLength(32);
      } else {
        await expect(stopping).resolves.toMatchObject({ status: "stopped" });
        expect(await readFile(capabilityPath)).toEqual(Buffer.alloc(32, race === "replacement" ? 31 : 32));
        await expect(stat(movedPath)).resolves.toMatchObject({ size: 0 });
      }
    },
  );

  it.each(["writeFile", "sync", "close"] as const)(
    "시작 lock %s 실패 뒤 replacement 삭제 없이 다음 정상 시작을 허용한다",
    async (stage) => {
      const root = await mkdtemp(join(tmpdir(), "massion-local-control-lock-failure-"));
      roots.push(root);
      const nodeExecutable = join(root, "node");
      const serverScript = join(root, "server.js");
      await Promise.all([writeFile(nodeExecutable, "", { mode: 0o700 }), writeFile(serverScript, "", { mode: 0o600 })]);
      const dependencies = {
        environment: { HOME: root },
        nodeExecutable,
        serverScript,
        fetcher: async () => Response.json({ status: "ready" }),
        processExists: () => true,
        processCommand: async () => `${nodeExecutable} ${serverScript}`,
        spawnProcess: () => ({ pid: 42, unref() {} }),
        surrealRuntime: {
          start: async () => ({ status: "already-running" as const, pid: 41, endpoint: "http://127.0.0.1:7330" }),
          stop: async () => ({ status: "stopped" as const, pid: 41 }),
        },
      };
      lockFailure.stage = stage;

      await expect(new LocalDaemonManager(dependencies).start()).rejects.toThrow(`start lock ${stage} failed`);
      lockFailure.stage = undefined;

      await expect(new LocalDaemonManager(dependencies).start()).resolves.toMatchObject({ pid: 42 });
      await expect(stat(resolveLocalPaths({ HOME: root }).startLock)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("시작 lock retire barrier에서 교체된 파일을 삭제하거나 내용을 바꾸지 않는다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-control-lock-replacement-"));
    roots.push(root);
    const nodeExecutable = join(root, "node");
    const serverScript = join(root, "server.js");
    await Promise.all([writeFile(nodeExecutable, "", { mode: 0o700 }), writeFile(serverScript, "", { mode: 0o600 })]);
    let enteredRetire: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredRetire = resolve;
    });
    let releaseRetire: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releaseRetire = resolve;
    });
    const manager = new LocalDaemonManager({
      environment: { HOME: root },
      nodeExecutable,
      serverScript,
      fetcher: async () => Response.json({ status: "ready" }),
      processExists: () => true,
      processCommand: async () => `${nodeExecutable} ${serverScript}`,
      spawnProcess: () => ({ pid: 42, unref() {} }),
      beforeStartLockRetire: async () => {
        enteredRetire?.();
        await release;
      },
      surrealRuntime: {
        start: async () => ({ status: "already-running", pid: 41, endpoint: "http://127.0.0.1:7330" }),
        stop: async () => ({ status: "stopped", pid: 41 }),
      },
    });
    const paths = resolveLocalPaths({ HOME: root });

    const starting = manager.start();
    await entered;
    const originalPath = join(paths.stateDirectory, "original-lock");
    await rename(paths.startLock, originalPath);
    await writeFile(paths.startLock, "replacement-lock\n", { mode: 0o600, flag: "wx" });
    releaseRetire?.();
    await starting;

    expect(await readFile(originalPath, "utf8")).toBe(`${String(process.pid)}\n`);
    const retired = (await readdir(paths.stateDirectory)).find((entry) =>
      entry.startsWith("server.start.lock.retired-"),
    );
    if (!retired) throw new Error("retired 시작 lock 파일이 없습니다");
    expect(await readFile(join(paths.stateDirectory, retired), "utf8")).toBe("replacement-lock\n");
  });

  it("세 runtime identity와 endpoint가 일치하는 준비된 v3 process를 재사용한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-control-reuse-"));
    roots.push(root);
    const nodeExecutable = join(root, "node");
    const serverScript = join(root, "server.js");
    const spawnProcess = vi.fn(() => ({ pid: 42, unref() {} }));
    const signal = vi.fn();
    const manager = new LocalDaemonManager({
      environment: { HOME: root },
      nodeExecutable,
      serverScript,
      runtimeVersion: "2.4.0",
      fetcher: async () => Response.json({ status: "ready" }),
      processExists: () => true,
      processCommand: async () => `${nodeExecutable} ${serverScript}`,
      signal,
      spawnProcess,
      surrealRuntime: {
        start: async () => ({ status: "already-running", pid: 41, endpoint: "http://127.0.0.1:7330" }),
        stop: async () => ({ status: "stopped", pid: 41 }),
      },
    });
    await manager.initializeStateForTest({ pid: 41, endpoint: "http://127.0.0.1:7331" });

    await expect(manager.start()).resolves.toEqual({
      status: "already-running",
      pid: 41,
      endpoint: "http://127.0.0.1:7331",
    });
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
  });

  it("기존 60초 polling 경계를 넘겨 부팅 중인 현재 v3 process를 재사용한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-control-slow-reuse-"));
    roots.push(root);
    const nodeExecutable = join(root, "node");
    const serverScript = join(root, "server.js");
    const spawnProcess = vi.fn(() => ({ pid: 42, unref() {} }));
    const signal = vi.fn();
    let readinessChecks = 0;
    const manager = new LocalDaemonManager({
      environment: { HOME: root },
      nodeExecutable,
      serverScript,
      runtimeVersion: "2.4.0",
      fetcher: async () => Response.json({ status: (readinessChecks += 1) === 241 ? "ready" : "starting" }),
      processExists: () => true,
      processCommand: async () => `${nodeExecutable} ${serverScript}`,
      signal,
      wait: async () => undefined,
      spawnProcess,
      surrealRuntime: {
        start: async () => ({ status: "already-running", pid: 41, endpoint: "http://127.0.0.1:7330" }),
        stop: async () => ({ status: "stopped", pid: 41 }),
      },
    });
    await manager.initializeStateForTest({ pid: 41, endpoint: "http://127.0.0.1:7331" });

    await expect(manager.start()).resolves.toEqual({
      status: "already-running",
      pid: 41,
      endpoint: "http://127.0.0.1:7331",
    });
    expect(readinessChecks).toBe(241);
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
  });

  it.each([
    ["v1", { schema: "massion.local-process.v1" }],
    ["Node 불일치", { schema: "massion.local-process.v2", nodeExecutable: "/old/node", runtimeVersion: "2.4.0" }],
    ["server 불일치", { schema: "massion.local-process.v2", serverScript: "/old/server.js", runtimeVersion: "2.4.0" }],
    ["runtime 불일치", { schema: "massion.local-process.v2", runtimeVersion: "1.0.0" }],
    ["endpoint 불일치", { schema: "massion.local-process.v2", endpoint: "http://127.0.0.1:7441" }],
  ])("소유가 확인된 %s PID 상태를 종료한 뒤 현재 runtime으로 교체한다", async (_label, mismatch) => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-control-replace-"));
    roots.push(root);
    const nodeExecutable = join(root, "node");
    const serverScript = join(root, "server.js");
    await Promise.all([writeFile(nodeExecutable, "", { mode: 0o700 }), writeFile(serverScript, "", { mode: 0o600 })]);
    const paths = resolveLocalPaths({ HOME: root });
    await ensureLocalDataEpoch(paths);
    await mkdir(paths.stateDirectory, { recursive: true, mode: 0o700 });
    const record =
      mismatch.schema === "massion.local-process.v1"
        ? {
            schema: "massion.local-process.v1",
            pid: 41,
            endpoint: "http://127.0.0.1:7331",
            serverScript,
            startedAt: new Date(0).toISOString(),
          }
        : {
            schema: "massion.local-process.v2",
            pid: 41,
            endpoint: "http://127.0.0.1:7331",
            nodeExecutable,
            serverScript,
            runtimeVersion: "2.4.0",
            startedAt: new Date(0).toISOString(),
            ...mismatch,
          };
    await writeFile(paths.pidFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    let oldAlive = true;
    let spawned = false;
    const signal = vi.fn((pid: number) => {
      if (pid === 41) oldAlive = false;
    });
    const manager = new LocalDaemonManager({
      environment: { HOME: root },
      nodeExecutable,
      serverScript,
      runtimeVersion: "2.4.0",
      fetcher: async () => Response.json({ status: spawned ? "ready" : "starting" }),
      processExists: (pid) => (pid === 41 ? oldAlive : true),
      processCommand: async () => {
        const recordedNode = "nodeExecutable" in record ? record.nodeExecutable : nodeExecutable;
        return `${recordedNode} ${record.serverScript}`;
      },
      signal,
      wait: async () => undefined,
      spawnProcess: () => {
        spawned = true;
        return { pid: 42, unref() {} };
      },
      surrealRuntime: {
        start: async () => ({ status: "already-running", pid: 40, endpoint: "http://127.0.0.1:7330" }),
        stop: async () => ({ status: "stopped", pid: 40 }),
      },
    });

    await expect(manager.start()).resolves.toMatchObject({ status: "started", pid: 42 });
    expect(signal).toHaveBeenCalledWith(41, "SIGTERM");
  });
});
