import { Command, CommanderError } from "commander";

export type CliOutputMode = "human" | "json" | "jsonl";

export interface CliInvocation {
  readonly command: string;
  readonly subcommand?: string;
  readonly arguments: readonly string[];
  readonly output: CliOutputMode;
  readonly detach: boolean;
  readonly wait: boolean;
  readonly retryBlocked: boolean;
  readonly after?: number;
  readonly events?: "jsonl";
  readonly profile?: string;
  readonly model?: string;
  readonly newAccount: boolean;
  readonly correlationId?: string;
}

interface CommandDefinition {
  readonly description: string;
  readonly subcommands?: Readonly<Record<string, string>>;
}

interface CommanderOptions {
  readonly after?: unknown;
  readonly correlation?: unknown;
  readonly detach?: unknown;
  readonly events?: unknown;
  readonly json?: unknown;
  readonly jsonl?: unknown;
  readonly model?: unknown;
  readonly newAccount?: unknown;
  readonly profile?: unknown;
  readonly retryBlocked?: unknown;
  readonly wait?: unknown;
}

const COMMANDS: Readonly<Record<string, CommandDefinition>> = {
  version: { description: "설치된 Massion 버전 표시" },
  update: { description: "업데이트 확인" },
  upgrade: { description: "호환 가능한 업데이트 설치" },
  local: {
    description: "개인용 local runtime 관리",
    subcommands: {
      start: "local runtime 시작",
      status: "local runtime 상태 확인",
      backup: "local data backup 생성",
      stop: "local runtime 종료",
      ensure: "필요하면 local runtime 준비",
    },
  },
  init: { description: "개인용 profile 초기화" },
  status: { description: "애플리케이션 상태 확인" },
  run: { description: "새 업무 실행" },
  resume: { description: "중단된 업무 재개" },
  watch: { description: "이벤트 stream 관찰" },
  org: { description: "조직 관리", subcommands: { graph: "조직 graph 조회", apply: "조직 변경 적용" } },
  work: {
    description: "업무 관리",
    subcommands: {
      list: "업무 목록 조회",
      get: "업무 조회",
      "follow-up": "후속 업무 생성",
      fork: "업무 분기",
      cancel: "업무 취소",
    },
  },
  chat: {
    description: "협업 대화 관리",
    subcommands: {
      rooms: "대화방 목록 조회",
      messages: "대화 조회",
      send: "메시지 전송",
      join: "대화방 참여",
      leave: "대화방 나가기",
    },
  },
  task: { description: "작업 배정", subcommands: { assign: "작업 배정", reassign: "작업 재배정" } },
  approval: {
    description: "승인 관리",
    subcommands: { list: "승인 목록", get: "승인 조회", approve: "승인", reject: "거절", cancel: "승인 취소" },
  },
  assurance: {
    description: "검증 보증 관리",
    subcommands: {
      "binding-propose": "보증 binding 제안",
      "binding-activate": "보증 binding 활성화",
      "binding-get": "보증 binding 조회",
      "binding-active": "활성 보증 binding 조회",
    },
  },
  runtime: {
    description: "실행 runtime 관리",
    subcommands: {
      get: "실행 조회",
      lineage: "실행 계보 조회",
      cancel: "실행 취소",
      suspend: "실행 일시 중지",
      resume: "실행 재개",
    },
  },
  provider: {
    description: "Provider 설정",
    subcommands: {
      list: "Provider 목록",
      "provider-add": "Provider 등록",
      "endpoint-add": "endpoint 등록",
      "credential-add": "credential 등록",
      "credential-disable": "credential 비활성화",
      "model-add": "model 등록",
      "route-set": "route 설정",
      "candidate-add": "candidate 등록",
    },
  },
  ext: {
    description: "Extension 관리",
    subcommands: {
      validate: "Extension 검증",
      link: "Extension 연결",
      pack: "Extension package 생성",
      publish: "Extension publish",
      search: "Extension 검색",
      info: "Extension 정보",
      install: "Extension 설치",
      update: "Extension 업데이트",
      rollback: "Extension 되돌리기",
      recall: "Extension 회수",
      inventory: "설치된 Extension 목록",
      list: "Extension 목록",
    },
  },
  integration: {
    description: "외부 연동 관리",
    subcommands: {
      list: "연동 목록",
      deliveries: "연동 delivery 조회",
      "oauth-start": "OAuth 시작",
      connect: "연동 연결",
      "user-bind": "사용자 연결",
      "channel-bind": "채널 연결",
    },
  },
  growth: {
    description: "성장 설정 관리",
    subcommands: {
      status: "성장 설정 조회",
      configure: "성장 설정",
      suggestions: "제안 조회",
      adopt: "제안 적용",
      revert: "제안 되돌리기",
    },
  },
  optimization: {
    description: "모델 최적화 관리",
    subcommands: {
      policy: "최적화 정책 조회",
      receipts: "최적화 영수증 조회",
      recommendations: "추천 조회",
      observations: "관측 조회",
      "batch-active": "활성 batch 조회",
      "policy-configure": "최적화 정책 설정",
      "bundle-create": "평가 bundle 생성",
      "bundle-export": "평가 bundle export",
      "bundle-import": "평가 bundle import",
      "evaluation-execute": "평가 실행",
      recommend: "추천 생성",
      "recommendation-approve": "추천 승인",
      "batch-create": "batch 생성",
      "batch-activate": "batch 활성화",
      recover: "최적화 복구",
    },
  },
  subscription: {
    description: "구독 Provider 관리",
    subcommands: {
      providers: "Provider 목록",
      enroll: "Connector enrollment 발급",
      "connect-model": "model 구독 연결",
      "connect-advanced": "고급 구독 연결",
      accounts: "구독 계정 목록",
      share: "구독 계정 공유",
      unshare: "구독 계정 공유 해제",
      quota: "구독 quota 조회",
      policy: "구독 정책 조회 또는 설정",
      doctor: "구독 진단",
      disconnect: "구독 연결 해제",
    },
  },
  auth: { description: "Provider 인증", subcommands: { login: "Provider 로그인" } },
  doctor: { description: "애플리케이션 진단" },
};

export class CliInformationalOutput extends Error {
  constructor(readonly output: string) {
    super("CLI informational output");
  }
}

function configureCommonOptions(command: Command): Command {
  return command
    .option("--json", "한 개의 JSON 결과를 stdout에 출력")
    .option("--jsonl", "JSON Lines 결과를 stdout에 출력")
    .option("--detach", "업무를 백그라운드로 분리")
    .option("--wait", "업무가 끝날 때까지 대기")
    .option("--retry-blocked", "중단된 업무를 다시 시도")
    .option("--after <cursor>", "이 cursor 뒤의 이벤트부터 관찰")
    .option("--events <format>", "이벤트 출력 형식")
    .option("--profile <name>", "사용할 연결 profile")
    .option("--model <id>", "로그인에 사용할 model")
    .option("--new-account", "기존 profile 대신 새 계정 추가")
    .option("--correlation <uuid>", "업무 상관관계 ID");
}

function commandFromAction(values: readonly unknown[]): Command {
  const command = values.at(-1);
  if (!(command instanceof Command)) throw new Error("Commander command context가 없습니다");
  return command;
}

function argumentsFromAction(values: readonly unknown[]): readonly string[] {
  const arguments_ = values[0];
  if (!Array.isArray(arguments_)) return [];
  const parsed: string[] = [];
  for (const value of arguments_) {
    if (typeof value !== "string") return [];
    parsed.push(value);
  }
  return parsed;
}

function optionString(value: unknown, option: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error(`${option} option 값이 필요합니다`);
  return value;
}

function invocationFrom(
  command: string,
  subcommand: string | undefined,
  arguments_: readonly string[],
  source: Command,
): CliInvocation {
  const options = source.optsWithGlobals<CommanderOptions>();
  const output = options.json ? "json" : options.jsonl ? "jsonl" : "human";
  if (options.json && options.jsonl) throw new Error("--json과 --jsonl을 동시에 사용할 수 없습니다");

  const afterText = optionString(options.after, "--after");
  let after: number | undefined;
  if (afterText !== undefined) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(afterText) || !Number.isSafeInteger(Number(afterText))) {
      throw new Error("--after cursor가 유효하지 않습니다");
    }
    after = Number(afterText);
  }

  const events = optionString(options.events, "--events");
  if (events !== undefined && events !== "jsonl") throw new Error("--events는 jsonl만 지원합니다");
  const profile = optionString(options.profile, "--profile");
  if (profile !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(profile)) {
    throw new Error("profile 이름이 유효하지 않습니다");
  }
  const model = optionString(options.model, "--model");
  if (model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(model)) {
    throw new Error("model ID가 유효하지 않습니다");
  }
  const correlationId = optionString(options.correlation, "--correlation");
  if (
    correlationId !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(correlationId)
  ) {
    throw new Error("상관관계 ID가 UUID 형식이 아닙니다");
  }

  const detach = options.detach === true;
  const wait = options.wait === true;
  const retryBlocked = options.retryBlocked === true;
  const newAccount = options.newAccount === true;
  if (detach && wait) throw new Error("--detach와 --wait를 동시에 사용할 수 없습니다");
  if (command === "watch" && events !== "jsonl") throw new Error("watch에는 --events jsonl이 필요합니다");
  if (retryBlocked && command !== "resume")
    throw new Error("--retry-blocked는 resume command에서만 사용할 수 있습니다");
  if (model !== undefined && !(command === "auth" && subcommand === "login")) {
    throw new Error("--model은 auth login에서만 사용할 수 있습니다");
  }
  if (newAccount && !(command === "auth" && subcommand === "login")) {
    throw new Error("--new-account는 auth login에서만 사용할 수 있습니다");
  }
  if (correlationId !== undefined && command !== "run")
    throw new Error("--correlation은 run command에서만 사용할 수 있습니다");
  return {
    command,
    ...(subcommand === undefined ? {} : { subcommand }),
    arguments: arguments_,
    output,
    detach,
    wait,
    retryBlocked,
    ...(after === undefined ? {} : { after }),
    ...(events === undefined ? {} : { events }),
    ...(profile === undefined ? {} : { profile }),
    ...(model === undefined ? {} : { model }),
    newAccount,
    ...(correlationId === undefined ? {} : { correlationId }),
  };
}

function commanderError(error: CommanderError, argv: readonly string[]): Error {
  if (error.code === "commander.unknownCommand") {
    const command = argv[0];
    if (command && COMMANDS[command]?.subcommands) return new Error(`${command} subcommand가 유효하지 않습니다`);
    return new Error("지원하지 않는 massion command입니다");
  }
  if (error.code === "commander.unknownOption") return new Error("지원하지 않는 option입니다");
  if (error.code === "commander.optionMissingArgument") return new Error("option 값이 필요합니다");
  return new Error("massion 사용법이 올바르지 않습니다");
}

function addLeaf(
  parent: Command,
  name: string,
  command: string,
  subcommand: string | undefined,
  description: string,
  setInvocation: (invocation: CliInvocation) => void,
): void {
  const leaf = configureCommonOptions(parent.command(name).description(description).argument("[arguments...]"));
  leaf.action((...values: unknown[]) => {
    setInvocation(invocationFrom(command, subcommand, argumentsFromAction(values), commandFromAction(values)));
  });
}

function createProgram(
  setInvocation: (invocation: CliInvocation) => void,
  writeOutput: (value: string) => void,
): Command {
  const program = configureCommonOptions(
    new Command()
      .name("massion")
      .description("개인용 multi-agent operating system")
      .version("Massion AgentOS 1.0.0", "-v, --version", "버전 표시"),
  );
  program.exitOverride().configureOutput({ writeOut: writeOutput, writeErr: writeOutput });
  program.addHelpText(
    "after",
    '\n예시:\n  massion status --json\n  massion run "첫 번째 작업" --wait\n  massion auth login\n',
  );

  for (const [command, definition] of Object.entries(COMMANDS)) {
    if (!definition.subcommands) {
      addLeaf(program, command, command, undefined, definition.description, setInvocation);
      continue;
    }
    const parent = program.command(command).description(definition.description);
    for (const [subcommand, description] of Object.entries(definition.subcommands)) {
      addLeaf(parent, subcommand, command, subcommand, description, setInvocation);
    }
  }
  return program;
}

export function parseCliArguments(argv: readonly string[]): CliInvocation {
  let invocation: CliInvocation | undefined;
  let output = "";
  const program = createProgram(
    (value) => {
      invocation = value;
    },
    (value) => {
      output += value;
    },
  );
  try {
    program.parse(["node", "massion", ...argv]);
  } catch (error) {
    if (error instanceof CliInformationalOutput) throw error;
    if (error instanceof CommanderError) {
      if (["commander.help", "commander.helpDisplayed", "commander.version"].includes(error.code)) {
        throw new CliInformationalOutput(output);
      }
      throw commanderError(error, argv);
    }
    throw error;
  }
  if (!invocation) {
    if (argv.length === 0) throw new CliInformationalOutput(program.helpInformation());
    throw new Error("massion command를 해석하지 못했습니다");
  }
  return invocation;
}
