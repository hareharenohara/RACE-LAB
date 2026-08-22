export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    const parts = [value.message, value.details, value.hint, value.code]
      .filter((part): part is string =>
        typeof part === "string" && part.trim().length > 0
      );
    if (parts.length) return [...new Set(parts)].join(" / ");
    try {
      return JSON.stringify(error);
    } catch {
      return "UNKNOWN_STRUCTURED_ERROR";
    }
  }
  return String(error);
}
