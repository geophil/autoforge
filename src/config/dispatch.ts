export interface DispatchConfig {
  epsilon: number;
  baselineMinTrafficShare: number;
  maxShadowVariantsPerAgentType: number;
}

export const defaultDispatchConfig: DispatchConfig = {
  epsilon: 0.1,
  baselineMinTrafficShare: 0.5,
  maxShadowVariantsPerAgentType: 3
};
