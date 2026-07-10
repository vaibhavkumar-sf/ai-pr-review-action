export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  maxTokens: number;
  temperature: number;
  timeout: number;
  /**
   * Per-call extended-thinking budget override (tokens). Omit to use the
   * provider default. Set to 0 to DISABLE thinking for this call — used for
   * cosmetic/formatting calls (PR description, diagrams) where deep reasoning
   * adds latency without value. The code-review calls omit this and keep full
   * thinking.
   */
  thinkingBudget?: number;
}

export interface ChatResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
  /** Anthropic stop_reason (`end_turn`, `max_tokens`, …) — used for diagnostics. */
  stopReason?: string | null;
}

/** Result of a successful pre-flight connectivity check. */
export interface ConnectionCheckResult {
  /** The model that answered (also latched as the resolved model). */
  model: string;
  /** Round-trip latency of the tiny probe request, in milliseconds. */
  latencyMs: number;
  /** Output tokens the probe returned (sanity signal that generation works). */
  outputTokens: number;
}

export interface AIProvider {
  chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResponse>;
  /** Logs the model + endpoint in use and best-effort lists available models. Never throws. */
  logDiagnostics(): Promise<void>;
  /**
   * Fails fast: sends a tiny probe to confirm the endpoint answers and to resolve
   * which model in the fallback chain works, BEFORE any expensive context
   * gathering. Latches the working model. Throws a clear error if unreachable.
   */
  verifyConnection(timeoutMs?: number): Promise<ConnectionCheckResult>;
  /** The model actually used after fallback resolution (for reporting). */
  getResolvedModel(): string;
}
