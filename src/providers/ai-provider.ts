/** One tool the model may call, in dialect-neutral form; each provider
 *  translates to its wire shape (Anthropic input_schema / OpenAI function). */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>;
}

/** A tool invocation requested by the model. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Tool calls this assistant turn requested (tool-loop transcripts only). */
  toolCalls?: ToolCall[];
  /** For role 'tool': id of the call this message answers. */
  toolCallId?: string;
}

export interface ChatOptions {
  maxTokens: number;
  /** True when maxTokens was auto-resolved from max_tokens: 0 (logging only). */
  maxTokensAuto?: boolean;
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
  /** Tools the model may call this turn (omit = tool use disabled). */
  tools?: ToolDefinition[];
  /**
   * Request a guaranteed-valid-JSON response where the endpoint supports it
   * (OpenAI-dialect `response_format: {type:'json_object'}`). Best-effort:
   * dialects/endpoints that don't support it ignore the hint, and the agent's
   * JSON-healing path remains the cross-provider safety net.
   */
  jsonMode?: boolean;
}

export interface ChatResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
  /** Anthropic stop_reason (`end_turn`, `max_tokens`, …); normalized to
   *  'tool_use' when the model requested tools (OpenAI: 'tool_calls'). */
  stopReason?: string | null;
  /** Tool calls the model requested (present when stopReason is 'tool_use'). */
  toolCalls?: ToolCall[];
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
  /**
   * Bounded tool loop: chat with tools enabled, executing requested tool
   * calls via `execute` and feeding results back, until the model answers
   * without tools or the bounds are hit (the final turn is then forced
   * tool-less so a findings answer is guaranteed). Every turn goes through
   * chat(), inheriting the full retry machinery. Returns the final response
   * plus the full transcript (for downstream repair retries).
   */
  chatWithTools(
    messages: ChatMessage[],
    options: ChatOptions,
    tools: ToolDefinition[],
    execute: (call: ToolCall) => Promise<string>,
    bounds: { maxRounds: number; maxCalls: number },
  ): Promise<{ response: ChatResponse; transcript: ChatMessage[] }>;
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
