export interface RunBudgetConfig {
  budgetSeconds: number;
  qmdTotalAllowanceSeconds?: number;
  qmdCallTimeoutSeconds?: number;
  modelCallTimeoutSeconds?: number;
  finalReserveSeconds?: number;
  nowMs?: () => number;
}

export interface TimeoutDecision {
  timeoutMs: number;
  timeoutSeconds: number;
  baseRemainingMs: number;
  wallRemainingMs: number;
  failureSubtype?: "qmd_allowance_exceeded";
}

const DEFAULT_QMD_ALLOWANCE_SECONDS = 90;
const DEFAULT_QMD_CALL_TIMEOUT_SECONDS = 20;
const DEFAULT_FINAL_RESERVE_SECONDS = 75;

export class RunBudget {
  private readonly startMs: number;
  private readonly baseBudgetMs: number;
  private readonly qmdAllowanceMs: number;
  private readonly qmdCallTimeoutMs: number;
  private readonly modelCallTimeoutMs?: number;
  private readonly finalReserveMs: number;
  private readonly nowMs: () => number;
  private qmdUsedMs = 0;

  constructor(config: RunBudgetConfig) {
    this.nowMs = config.nowMs ?? Date.now;
    this.startMs = this.nowMs();
    this.baseBudgetMs = config.budgetSeconds * 1000;
    this.qmdAllowanceMs = (config.qmdTotalAllowanceSeconds ?? DEFAULT_QMD_ALLOWANCE_SECONDS) * 1000;
    this.qmdCallTimeoutMs = (config.qmdCallTimeoutSeconds ?? DEFAULT_QMD_CALL_TIMEOUT_SECONDS) * 1000;
    this.modelCallTimeoutMs = config.modelCallTimeoutSeconds ? config.modelCallTimeoutSeconds * 1000 : undefined;
    this.finalReserveMs = (config.finalReserveSeconds ?? DEFAULT_FINAL_RESERVE_SECONDS) * 1000;
  }

  get startedAtMs(): number {
    return this.startMs;
  }

  baseRemainingMs(): number {
    return Math.max(0, this.baseBudgetMs - this.nonQmdElapsedMs());
  }

  wallRemainingMs(): number {
    return Math.max(0, this.startMs + this.baseBudgetMs + this.qmdAllowanceMs - this.nowMs());
  }

  qmdAllowanceUsedMs(): number {
    return this.qmdUsedMs;
  }

  qmdAllowanceRemainingMs(): number {
    return Math.max(0, this.qmdAllowanceMs - this.qmdUsedMs);
  }

  isBaseExpired(): boolean {
    return this.baseRemainingMs() <= 0 || this.wallRemainingMs() <= 0;
  }

  isInFinalReserve(): boolean {
    return this.baseRemainingMs() <= this.finalReserveMs;
  }

  timeoutForModelCall(): TimeoutDecision {
    const candidates = [this.baseRemainingMs(), this.wallRemainingMs()];
    if (this.modelCallTimeoutMs !== undefined) candidates.push(this.modelCallTimeoutMs);
    const timeoutMs = Math.max(0, Math.min(...candidates));
    return {
      timeoutMs,
      timeoutSeconds: timeoutMs / 1000,
      baseRemainingMs: this.baseRemainingMs(),
      wallRemainingMs: this.wallRemainingMs()
    };
  }

  timeoutForLocalTool(): TimeoutDecision {
    const timeoutMs = Math.max(0, Math.min(this.baseRemainingMs(), this.wallRemainingMs()));
    return {
      timeoutMs,
      timeoutSeconds: timeoutMs / 1000,
      baseRemainingMs: this.baseRemainingMs(),
      wallRemainingMs: this.wallRemainingMs()
    };
  }

  timeoutForQmdCall(): TimeoutDecision {
    const qmdRemaining = this.qmdAllowanceRemainingMs();
    const timeoutMs = Math.max(0, Math.min(qmdRemaining, this.qmdCallTimeoutMs, this.wallRemainingMs()));
    return {
      timeoutMs,
      timeoutSeconds: timeoutMs / 1000,
      baseRemainingMs: this.baseRemainingMs(),
      wallRemainingMs: this.wallRemainingMs(),
      failureSubtype: timeoutMs <= 0 ? "qmd_allowance_exceeded" : undefined
    };
  }

  observeQmdElapsed(elapsedMs: number): void {
    this.qmdUsedMs += Math.max(0, elapsedMs);
  }

  modelCallTimeoutSeconds(): number | undefined {
    return this.modelCallTimeoutMs === undefined ? undefined : this.modelCallTimeoutMs / 1000;
  }

  private nonQmdElapsedMs(): number {
    return Math.max(0, this.nowMs() - this.startMs - this.qmdUsedMs);
  }
}
