/**
 * 모델 평가실 Application operation 이름을 한 곳에서 참조하기 위한 공개 계약입니다.
 * 실제 등록은 adapters/domain.ts와 query-registry.ts가 담당합니다.
 */
export const MODEL_OPTIMIZATION_OPERATIONS = [
  "optimization.policy.configure",
  "optimization.bundle.create",
  "optimization.bundle.export",
  "optimization.bundle.import",
  "optimization.evaluation.execute",
  "optimization.recommend",
  "optimization.recommendation.approve",
  "optimization.batch.create",
  "optimization.batch.activate",
  "optimization.recover",
] as const;

export const MODEL_OPTIMIZATION_QUERIES = [
  "optimization.policy",
  "optimization.receipts",
  "optimization.recommendations",
  "optimization.observations",
  "optimization.batch.active",
] as const;

export type ModelOptimizationOperation = (typeof MODEL_OPTIMIZATION_OPERATIONS)[number];
export type ModelOptimizationQuery = (typeof MODEL_OPTIMIZATION_QUERIES)[number];
