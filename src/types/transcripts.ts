export interface AgentTranscriptInput {
  taskId: string;
  stage: string;
  attempt: number;
  personaVersionId: string | null;
  executorUsed: string;
  model: string | null;
  systemPrompt: string;
  userPrompt: string;
  transcript: string;
  output: string | null;
  critique: string | null;
  tokenInput: number | null;
  tokenOutput: number | null;
  elapsedSeconds: number | null;
  /** When set, scopes transcript rows to a post-rollback retry era for iteration budgets. */
  rollbackEventId?: string | null;
}

export interface AgentTranscriptRow extends AgentTranscriptInput {
  id: string;
  createdAt: string;
  rollbackEventId?: string | null;
}

export interface AgentTranscriptMeta {
  id: string;
  taskId: string;
  stage: string;
  attempt: number;
  personaVersionId: string | null;
  createdAt: string;
  executorUsed: string;
  model: string | null;
  tokenInput: number | null;
  tokenOutput: number | null;
  elapsedSeconds: number | null;
  rollbackEventId?: string | null;
}
