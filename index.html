const MODEL = "gemini-3.6-flash";

export interface GeminiResult {
  value: unknown;
  raw: unknown;
  inputTokens?: number;
  outputTokens?: number;
}

export async function callGemini(prompt: string, responseSchema: Record<string, unknown>): Promise<GeminiResult> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY_MISSING");
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema },
    }),
  });
  const raw = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GEMINI_HTTP_${response.status}:${JSON.stringify(raw).slice(0, 500)}`);
  const text = raw?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("");
  if (!text) throw new Error("GEMINI_EMPTY_RESPONSE");
  return {
    value: JSON.parse(text), raw,
    inputTokens: raw?.usageMetadata?.promptTokenCount,
    outputTokens: raw?.usageMetadata?.candidatesTokenCount,
  };
}

export { MODEL };
