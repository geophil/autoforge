import { createHash } from "node:crypto";
import type { AppEnv } from "../config/env";

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

export function serializeEmbedding(vector: number[]): Buffer {
  const payload = JSON.stringify(vector);
  return Buffer.from(payload, "utf8");
}

export function deserializeEmbedding(blob: Buffer | Uint8Array | null): number[] | null {
  if (!blob) return null;
  const raw = Buffer.from(blob).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.every(Number.isFinite)) {
    return null;
  }
  return parsed;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function createDeterministicEmbeddingProvider(dimensions = 64): EmbeddingProvider {
  return {
    async embed(text: string): Promise<number[]> {
      const normalized = text.toLowerCase().trim();
      const values = new Array<number>(dimensions).fill(0);
      for (const token of normalized.split(/[^a-z0-9]+/).filter(Boolean)) {
        const digest = createHash("sha256").update(token).digest();
        for (let i = 0; i < dimensions; i += 1) {
          values[i] += (digest[i % digest.length] / 255) * 2 - 1;
        }
      }
      const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
      return norm === 0 ? values : values.map((value) => value / norm);
    }
  };
}

export function createOpenAIEmbeddingProvider(input: { apiKey: string; model: string }): EmbeddingProvider {
  return {
    async embed(text: string): Promise<number[]> {
      const response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${input.apiKey}`
        },
        body: JSON.stringify({ model: input.model, input: text })
      });
      if (!response.ok) {
        throw new Error(`embedding request failed: ${response.status}`);
      }
      const body = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
      const embedding = body.data?.[0]?.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every(Number.isFinite)) {
        throw new Error("embedding response missing numeric vector");
      }
      return embedding;
    }
  };
}

export function createEmbeddingProvider(env: AppEnv): EmbeddingProvider {
  if (env.EMBEDDING_PROVIDER === "openai") {
    if (!env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai");
    }
    return createOpenAIEmbeddingProvider({ apiKey: env.OPENAI_API_KEY, model: env.EMBEDDING_MODEL });
  }
  return createDeterministicEmbeddingProvider();
}
