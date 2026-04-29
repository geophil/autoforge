export interface DispatchConfig {
  epsilon: number;
  baselineMinTrafficShare: number;
  maxShadowVariantsPerAgentType: number;
  similarityThreshold: number;
  diagnosticTriggerTaskCount: number;
  forkApprovalTimeoutDays: number;
  forkProposalStaleDays: number;
}

export const defaultDispatchConfig: DispatchConfig = {
  epsilon: 0.1,
  baselineMinTrafficShare: 0.5,
  maxShadowVariantsPerAgentType: 3,
  similarityThreshold: 0.55,
  diagnosticTriggerTaskCount: 50,
  forkApprovalTimeoutDays: 30,
  forkProposalStaleDays: 14
};
