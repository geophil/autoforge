export interface StatisticalTestResult {
  pValue: number;
  effect: number;
  n: number;
}

interface RankedValue {
  value: number;
  rank: number;
  sample: "a" | "b";
}

const EXACT_ENUMERATION_LIMIT = 20;

export function wilcoxonSignedRankGreaterOrEqual(pairs: Array<[number, number]>): StatisticalTestResult {
  const finitePairs = pairs.filter(([sampleA, sampleB]) => Number.isFinite(sampleA) && Number.isFinite(sampleB));
  const effect = meanDifference(finitePairs);
  const rankedDifferences = averageRanks(
    finitePairs
      .map(([sampleA, sampleB]) => sampleA - sampleB)
      .filter((difference) => difference !== 0)
      .map((difference) => ({
        value: Math.abs(difference),
        sample: difference > 0 ? "a" as const : "b" as const
      }))
  );

  if (rankedDifferences.length === 0) {
    return { pValue: 1, effect, n: 0 };
  }

  const observed = rankedDifferences
    .filter((difference) => difference.sample === "a")
    .reduce((sum, difference) => sum + difference.rank, 0);

  return {
    pValue: clampPValue(oneSidedSignedRankPValue(rankedDifferences.map((difference) => difference.rank), observed)),
    effect,
    n: rankedDifferences.length
  };
}

export function mannWhitneyUGreater(sampleA: number[], sampleB: number[]): StatisticalTestResult {
  return mannWhitneyU(sampleA, sampleB, "greater");
}

export function mannWhitneyULess(sampleA: number[], sampleB: number[]): StatisticalTestResult {
  return mannWhitneyU(sampleA, sampleB, "less");
}

export function kolmogorovSmirnovTwoSample(sampleA: number[], sampleB: number[]): StatisticalTestResult {
  const a = sampleA.filter(Number.isFinite).sort((left, right) => left - right);
  const b = sampleB.filter(Number.isFinite).sort((left, right) => left - right);
  if (a.length === 0 || b.length === 0) {
    return { pValue: 1, effect: 0, n: 0 };
  }

  let i = 0;
  let j = 0;
  let d = 0;
  while (i < a.length || j < b.length) {
    const next = j >= b.length || (i < a.length && a[i] <= b[j]) ? a[i] : b[j];
    while (i < a.length && a[i] <= next) i += 1;
    while (j < b.length && b[j] <= next) j += 1;
    d = Math.max(d, Math.abs(i / a.length - j / b.length));
  }

  const nEff = (a.length * b.length) / (a.length + b.length);
  const pValue = Math.min(1, 2 * Math.exp(-2 * nEff * d * d));
  return { pValue: clampPValue(pValue), effect: mean(a) - mean(b), n: a.length + b.length };
}

function mannWhitneyU(sampleA: number[], sampleB: number[], direction: "greater" | "less"): StatisticalTestResult {
  const finiteA = sampleA.filter(Number.isFinite);
  const finiteB = sampleB.filter(Number.isFinite);
  const effect = finiteA.length === 0 || finiteB.length === 0 ? 0 : mean(finiteA) - mean(finiteB);

  if (finiteA.length < 2 || finiteB.length < 2) {
    return { pValue: 1, effect, n: 0 };
  }

  const ranked = averageRanks([
    ...finiteA.map((value) => ({ value, sample: "a" as const })),
    ...finiteB.map((value) => ({ value, sample: "b" as const }))
  ]);
  const rankSumA = ranked
    .filter((entry) => entry.sample === "a")
    .reduce((sum, entry) => sum + entry.rank, 0);
  const observedU = rankSumA - (finiteA.length * (finiteA.length + 1)) / 2;
  const pValue = finiteA.length + finiteB.length <= EXACT_ENUMERATION_LIMIT
    ? exactMannWhitneyPValue(ranked.map((entry) => entry.rank), finiteA.length, observedU, direction)
    : approximateMannWhitneyPValue(ranked, finiteA.length, finiteB.length, observedU, direction);

  return {
    pValue: clampPValue(pValue),
    effect,
    n: finiteA.length + finiteB.length
  };
}

function averageRanks(values: Array<{ value: number; sample: "a" | "b" }>): RankedValue[] {
  const sorted = values
    .map((entry, index) => ({ ...entry, index }))
    .sort((left, right) => left.value - right.value || left.index - right.index);
  const ranked = new Array<RankedValue>(sorted.length);

  let index = 0;
  while (index < sorted.length) {
    let end = index + 1;
    while (end < sorted.length && sorted[end].value === sorted[index].value) {
      end += 1;
    }

    const rank = (index + 1 + end) / 2;
    for (let rankIndex = index; rankIndex < end; rankIndex += 1) {
      const entry = sorted[rankIndex];
      ranked[entry.index] = { value: entry.value, sample: entry.sample, rank };
    }
    index = end;
  }

  return ranked;
}

function oneSidedSignedRankPValue(ranks: number[], observed: number): number {
  if (ranks.length <= EXACT_ENUMERATION_LIMIT) {
    let extreme = 0;
    const total = 2 ** ranks.length;

    for (let mask = 0; mask < total; mask += 1) {
      let sum = 0;
      for (let index = 0; index < ranks.length; index += 1) {
        if ((mask & (1 << index)) !== 0) {
          sum += ranks[index];
        }
      }
      if (sum >= observed - Number.EPSILON) {
        extreme += 1;
      }
    }

    return extreme / total;
  }

  const meanRankSum = ranks.reduce((sum, rank) => sum + rank, 0) / 2;
  const variance = ranks.reduce((sum, rank) => sum + rank * rank, 0) / 4;
  if (variance <= 0) {
    return 1;
  }

  const z = (observed - meanRankSum - 0.5) / Math.sqrt(variance);
  return 1 - normalCdf(z);
}

function exactMannWhitneyPValue(ranks: number[], sampleASize: number, observedU: number, direction: "greater" | "less"): number {
  let total = 0;
  let extreme = 0;

  function visit(startIndex: number, chosen: number, rankSum: number): void {
    if (chosen === sampleASize) {
      total += 1;
      const candidateU = rankSum - (sampleASize * (sampleASize + 1)) / 2;
      if (direction === "greater" ? candidateU >= observedU - Number.EPSILON : candidateU <= observedU + Number.EPSILON) {
        extreme += 1;
      }
      return;
    }

    const remainingNeeded = sampleASize - chosen;
    for (let index = startIndex; index <= ranks.length - remainingNeeded; index += 1) {
      visit(index + 1, chosen + 1, rankSum + ranks[index]);
    }
  }

  visit(0, 0, 0);
  return total === 0 ? 1 : extreme / total;
}

function approximateMannWhitneyPValue(
  ranked: RankedValue[],
  sampleASize: number,
  sampleBSize: number,
  observedU: number,
  direction: "greater" | "less"
): number {
  const meanU = (sampleASize * sampleBSize) / 2;
  const tieCorrection = tieCorrectionTerm(ranked);
  const totalSize = sampleASize + sampleBSize;
  const variance = (sampleASize * sampleBSize / 12) * ((totalSize + 1) - tieCorrection / (totalSize * (totalSize - 1)));

  if (variance <= 0) {
    return 1;
  }

  const continuity = direction === "greater" ? -0.5 : 0.5;
  const z = (observedU - meanU + continuity) / Math.sqrt(variance);
  return direction === "greater" ? 1 - normalCdf(z) : normalCdf(z);
}

function tieCorrectionTerm(ranked: RankedValue[]): number {
  const counts = new Map<number, number>();
  for (const entry of ranked) {
    counts.set(entry.value, (counts.get(entry.value) ?? 0) + 1);
  }

  let correction = 0;
  for (const count of counts.values()) {
    correction += count ** 3 - count;
  }
  return correction;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function meanDifference(pairs: Array<[number, number]>): number {
  return pairs.length === 0
    ? 0
    : pairs.reduce((sum, [sampleA, sampleB]) => sum + sampleA - sampleB, 0) / pairs.length;
}

function normalCdf(value: number): number {
  return 0.5 * (1 + erf(value / Math.SQRT2));
}

function erf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const approximation = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * approximation;
}

function clampPValue(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(1, Math.max(0, value));
}
