import { buildRenderPrompt, composeRenderPrompt, normalizeEvaluation, moderationFromLog } from "../server.mjs";

export const WORKFLOW_LIMITS = Object.freeze({ maxProducts: 5, maxProductViews: 8, maxModels: 10, maxVersions: 4 });

export function selectCandidate(evaluation) {
  return evaluation?.candidates?.find(item => item.index === evaluation.recommended_index) || evaluation?.candidates?.[0] || null;
}

export function retryInstructions(product) {
  return {
    attempt: (product?.outputs?.length || 0) + 1,
    rerenderReasons: product?.lastQc?.rerender_reasons || product?.lastQc?.critical_failure_reasons || [],
    rerenderKeep: product?.lastQc?.strengths || []
  };
}

export function isRetryableError(error) { return error?.code !== "moderation_blocked" && error?.retryable !== false; }

export { buildRenderPrompt, composeRenderPrompt, normalizeEvaluation, moderationFromLog };
