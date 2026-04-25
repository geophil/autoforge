import { extractKeywords } from "./lessons";

export function filterBySpecialty<T extends { status: string; specialty: string | null }>(
  variants: T[],
  taskDescription: string
): T[] {
  const taskKeywords = new Set(extractKeywords(taskDescription));

  return variants.filter((variant) => {
    if (variant.status === "baseline") return true;
    if (variant.specialty === null) return true;

    const specialtyKeywords = extractKeywords(variant.specialty);
    return specialtyKeywords.some((keyword) => taskKeywords.has(keyword));
  });
}
