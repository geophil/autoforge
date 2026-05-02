import type { DispatchVariantRow } from "../db/client";
import { defaultDispatchConfig } from "../config/dispatch";
import { filterBySpecialty } from "./specialty-match";
import { cosineSimilarity, deserializeEmbedding, type EmbeddingProvider } from "./embedding";

export interface ClassifierOptions {
  provider: EmbeddingProvider;
  similarityThreshold?: number;
}

export async function filterSpecialtyEligible(
  variants: DispatchVariantRow[],
  taskDescription: string,
  options: ClassifierOptions
): Promise<DispatchVariantRow[]> {
  const threshold = options.similarityThreshold ?? defaultDispatchConfig.similarityThreshold;
  const baselineAndGeneralists = variants.filter((variant) => variant.status === "baseline" || variant.specialty === null);
  const specialists = variants.filter((variant) => variant.status !== "baseline" && variant.specialty !== null);

  try {
    const taskEmbedding = await options.provider.embed(taskDescription);
    const embeddingMatches = specialists.filter((variant) => {
      const variantEmbedding = deserializeEmbedding(variant.specialty_embedding);
      return variantEmbedding !== null
        && isComparableEmbedding(taskEmbedding, variantEmbedding)
        && cosineSimilarity(taskEmbedding, variantEmbedding) >= threshold;
    });
    const keywordFallbackCandidates = specialists.filter((variant) => {
      const variantEmbedding = deserializeEmbedding(variant.specialty_embedding);
      return variantEmbedding === null || !isComparableEmbedding(taskEmbedding, variantEmbedding);
    });
    const keywordFallback = filterBySpecialty(keywordFallbackCandidates, taskDescription);
    return preserveOrder(variants, [...baselineAndGeneralists, ...embeddingMatches, ...keywordFallback]);
  } catch {
    return filterBySpecialty(variants, taskDescription);
  }
}

function isComparableEmbedding(a: number[], b: number[]): boolean {
  return a.length > 0 && a.length === b.length;
}

function preserveOrder(rows: DispatchVariantRow[], selected: DispatchVariantRow[]): DispatchVariantRow[] {
  const ids = new Set(selected.map((row) => row.id));
  return rows.filter((row) => ids.has(row.id));
}
