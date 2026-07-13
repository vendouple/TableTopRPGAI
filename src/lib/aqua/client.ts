export type AquaMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: AquaToolCall[];
};

export type AquaToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type AquaToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export function aquaConfig() {
  return {
    apiKey: process.env.AQUA_API_KEY || "",
    baseUrl: process.env.AQUA_BASE_URL || "https://api.aquadevs.com/v1",
    chatModel: process.env.AQUA_CHAT_MODEL || "grok-4.3",
    // Optional small/fast model for constrained ancillary tasks (backdrop
    // director, theme picker). Empty → those fall back to the main chat model.
    // The main narrative DM turn ALWAYS uses chatModel.
    fastModel: process.env.FAST_MODEL || process.env.AQUA_FAST_MODEL || "",
    imageModel: process.env.AQUA_IMAGE_MODEL || "gptimage-2"
  };
}

/** Progress info reported just before a retry, so callers can surface it. */
export type AquaRetryInfo = { attempt: number; retries: number; status?: number; error?: unknown };

export type AquaFetchOptions = {
  /** Max attempts (default 6). Interactive DM turns pass a small number so a dead endpoint fails fast. */
  retries?: number;
  /** Per-attempt abort timeout in ms (default 60000). */
  timeoutMs?: number;
  /** Called just before each retry with the UPCOMING attempt number, so the TV can show "retrying (2/3)". */
  onRetry?: (info: AquaRetryInfo) => void;
};

export async function aquaFetch(path: string, init: RequestInit, options: AquaFetchOptions | number = {}) {
  const config = aquaConfig();
  // Back-compat: a bare number used to mean `retries`.
  const opts: AquaFetchOptions = typeof options === "number" ? { retries: options } : options;
  const retries = Math.max(1, opts.retries ?? 6);
  const timeoutMs = opts.timeoutMs ?? 60000;
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (config.apiKey) headers.set("authorization", `Bearer ${config.apiKey}`);

  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${config.baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal
      });
      const text = await response.text();
      clearTimeout(timeoutId);
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }

      if (!response.ok) {
        if ((response.status >= 500 || response.status === 429) && attempt < retries) {
          const delay = attempt * 3000;
          console.warn(`Aqua API error ${response.status} on attempt ${attempt}/${retries}. Retrying in ${delay / 1000}s...`);
          opts.onRetry?.({ attempt: attempt + 1, retries, status: response.status });
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw new Error(`Aqua API ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
      }

      return data;
    } catch (error) {
      clearTimeout(timeoutId);
      if (attempt < retries) {
        const delay = attempt * 3000;
        console.warn(`Aqua fetch failed on attempt ${attempt}/${retries}: ${error}. Retrying in ${delay / 1000}s...`);
        opts.onRetry?.({ attempt: attempt + 1, retries, error });
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
}
