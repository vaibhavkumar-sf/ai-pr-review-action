export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  maxTokens: number;
  temperature: number;
  timeout: number;
}

export interface ChatResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
  /** Anthropic stop_reason (`end_turn`, `max_tokens`, …) — used for diagnostics. */
  stopReason?: string | null;
}

export interface AIProvider {
  chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResponse>;
  /** Logs the model + endpoint in use and best-effort lists available models. Never throws. */
  logDiagnostics(): Promise<void>;
}
