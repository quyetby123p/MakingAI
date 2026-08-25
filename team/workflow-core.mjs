import { buildRenderPrompt, composeRenderPrompt, normalizeEvaluation, moderationFromLog } from "../server.mjs";

export const WORKFLOW_LIMITS = Object.freeze({ maxProducts: 5, maxProductViews: 8, maxModels: 10, maxVersions: 4 });

export function selectCandidate(evaluation) {
  return evaluation?.candidates?.find(item => item.index === evaluation.recommended_index) || evaluation?.candidates?.[0] || null;
}

export function retryInstructions(product) {
  const attempt = (product?.outputs?.length || 0) + 1;
  const qcReasons = product?.lastQc?.rerender_reasons || product?.lastQc?.critical_failure_reasons || [];
  const fallbackReasons = [
    `create a fresh revision ${attempt} from the original model image and garment references`,
    "make the garment placement, fit and drape visibly re-evaluated while preserving the same product design"
  ];
  return {
    attempt,
    rerenderReasons: qcReasons.length ? qcReasons : fallbackReasons,
    rerenderKeep: product?.lastQc?.strengths || []
  };
}

export function isRetryableError(error) { return error?.code !== "moderation_blocked" && error?.retryable !== false; }

export { buildRenderPrompt, composeRenderPrompt, normalizeEvaluation, moderationFromLog };
