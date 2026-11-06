/** Canonical JSON identity across native serde object-key ordering. Array order remains meaningful. */
export function wireSignature(value: unknown): string {
  const normalize = (entry: unknown): unknown =>
    Array.isArray(entry)
      ? entry.map(normalize)
      : entry && typeof entry === "object"
        ? Object.fromEntries(
            Object.entries(entry)
              .filter(([, v]) => v !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, v]) => [key, normalize(v)]),
          )
        : entry;
  return JSON.stringify(normalize(value));
}
