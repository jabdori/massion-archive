import { createHash } from "node:crypto";

import { isOptimizationRoleKey } from "./scoring.js";
import type { EvaluationBundle, EvaluationCase } from "./contracts.js";

export const MODEL_OPTIMIZATION_EXPORT_SCHEMA = "massion.model-optimization-export.v1" as const;
const SHA256 = /^[a-f0-9]{64}$/u;

export interface EvaluationExport {
  readonly schema: typeof MODEL_OPTIMIZATION_EXPORT_SCHEMA;
  readonly exportVersion: 1;
  readonly license: string;
  readonly configurationChecksum: string;
  readonly bundle: EvaluationBundle;
  readonly cases: readonly EvaluationCase[];
  readonly checksum: string;
}

export interface CreateEvaluationExportInput {
  readonly license: string;
  readonly configurationChecksum: string;
  readonly bundle: EvaluationBundle;
  readonly cases: readonly EvaluationCase[];
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function text(value: unknown, label: string, maximum: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\0\r\n]/u.test(value))
    throw new Error(`${label}이(가) 유효하지 않습니다`);
}

function checksum(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} checksum이 유효하지 않습니다`);
}

function validateCase(value: EvaluationCase, bundle: EvaluationBundle): void {
  if (value.roleKey !== bundle.roleKey) throw new Error("export case role이 bundle과 다릅니다");
  if (!Number.isSafeInteger(value.version) || value.version < 1)
    throw new Error("export case version이 유효하지 않습니다");
  text(value.caseId, "export case ID", 256);
  checksum(value.promptChecksum, "prompt");
  checksum(value.toolsChecksum, "tools");
  checksum(value.environmentChecksum, "environment");
  text(value.expectedOutcome, "expected outcome", 4096);
  if (value.prompt !== undefined) text(value.prompt, "prompt", 16_384);
  if ((value.taskAxis === undefined) !== (value.reasoningDifficulty === undefined)) {
    throw new Error("export case의 작업 축과 추론 난이도는 함께 필요합니다");
  }
  if (
    value.taskAxis !== undefined &&
    !["code-generation", "code-understanding", "planning-design", "review-critique", "summary-records"].includes(
      value.taskAxis,
    )
  ) {
    throw new Error("export case 작업 축이 유효하지 않습니다");
  }
  if (value.reasoningDifficulty !== undefined && !["low", "medium", "high"].includes(value.reasoningDifficulty)) {
    throw new Error("export case 추론 난이도가 유효하지 않습니다");
  }
}

function unsigned(value: EvaluationExport): Omit<EvaluationExport, "checksum"> {
  const { checksum, ...rest } = value;
  void checksum;
  return rest;
}

export function createEvaluationExport(input: CreateEvaluationExportInput): EvaluationExport {
  const value: EvaluationExport = {
    schema: MODEL_OPTIMIZATION_EXPORT_SCHEMA,
    exportVersion: 1,
    license: input.license,
    configurationChecksum: input.configurationChecksum,
    bundle: input.bundle,
    cases: input.cases,
    checksum: "",
  };
  text(value.license, "license", 256);
  checksum(value.configurationChecksum, "configuration");
  validateEvaluationExport({ ...value, checksum: digest(unsigned(value)) });
  return { ...value, checksum: digest(unsigned(value)) };
}

export function validateEvaluationExport(value: unknown): EvaluationExport {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("model export는 object여야 합니다");
  const candidate = value as Partial<EvaluationExport>;
  if (candidate.schema !== MODEL_OPTIMIZATION_EXPORT_SCHEMA || candidate.exportVersion !== 1)
    throw new Error("model export schema가 유효하지 않습니다");
  text(candidate.license, "license", 256);
  checksum(candidate.configurationChecksum, "configuration");
  if (!candidate.bundle || typeof candidate.bundle !== "object" || Array.isArray(candidate.bundle))
    throw new Error("export bundle이 유효하지 않습니다");
  const bundle = candidate.bundle;
  if (!isOptimizationRoleKey(bundle.roleKey)) throw new Error("export bundle role이 유효하지 않습니다");
  if (!Number.isSafeInteger(bundle.version) || bundle.version < 1)
    throw new Error("export bundle version이 유효하지 않습니다");
  checksum(bundle.checksum, "bundle");
  text(bundle.bundleId, "export bundle ID", 256);
  text(bundle.runtimeVersion, "export runtime version", 256);
  if (!Array.isArray(bundle.caseIds) || bundle.caseIds.length < 1 || bundle.caseIds.length > 128)
    throw new Error("export case ID 목록이 유효하지 않습니다");
  if (!Array.isArray(candidate.cases) || candidate.cases.length !== bundle.caseIds.length)
    throw new Error("export case 수가 bundle과 다릅니다");
  const caseIds = candidate.cases.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("export case가 유효하지 않습니다");
    validateCase(item as EvaluationCase, bundle);
    return (item as EvaluationCase).caseId;
  });
  if (new Set(caseIds).size !== caseIds.length || caseIds.some((id) => !bundle.caseIds.includes(id)))
    throw new Error("export case 계보가 bundle과 다릅니다");
  checksum(candidate.checksum, "export");
  if (candidate.checksum !== digest(unsigned(candidate as EvaluationExport)))
    throw new Error("export checksum이 일치하지 않습니다");
  return candidate as EvaluationExport;
}
