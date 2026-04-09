import { randomUUID } from "node:crypto";
import type { ReviewFinding } from "../types/core";

export interface PrPayload {
  title: string;
  description: string;
  branch: string;
  findings: ReviewFinding[];
}

export interface PrGateResult {
  accepted: boolean;
  reason?: string;
}

export function evaluatePrGate(params: {
  passRate: number;
  reviewScore: number;
  findings: ReviewFinding[];
  thresholdScore: number;
}): PrGateResult {
  if (params.passRate < 1) {
    return { accepted: false, reason: "test_pass_rate_below_100" };
  }
  if (params.reviewScore < params.thresholdScore) {
    return { accepted: false, reason: "review_score_below_threshold" };
  }
  if (params.findings.some((finding) => finding.severity === "CRITICAL" && !finding.resolved)) {
    return { accepted: false, reason: "critical_findings_unresolved" };
  }
  return { accepted: true };
}

export async function createPullRequest(payload: PrPayload): Promise<string> {
  return `https://example.local/pr/${randomUUID()}?branch=${encodeURIComponent(payload.branch)}&title=${encodeURIComponent(payload.title)}`;
}
