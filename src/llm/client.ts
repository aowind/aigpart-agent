import type {
  ChatMessage,
  ClientOptions,
  CompletionResult,
  StreamCallbacks,
  ToolCall,
  ToolDef,
  Usage,
} from './types.js';

/**
 * OpenAI 兼容的 LLM 客户端。
 * 经本地 8787 代理转发，model 名按前缀路由到 DeepSeek / GLM 等上游。
 */
export class LLMClient {
  readonly baseURL: string;
  readonly apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;

  constructor(opts: ClientOptions) {
    this.baseURL = opts.baseURL.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.maxTokens = opts.maxTokens ?? 8192;
    this.temperature = opts.temperature ?? 0;
  }

  private url(path: string): string {
    return `${this.baseURL}${path}`;
  }

  /** 非流式请求：一次拿完整 message（含 tool_calls），agent loop 用它。 */
  async chat(messages: ChatMessage[], tools?: ToolDef[]): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
    };
    if (tools && tools.length) body.tools = tools;

    const resp = await fetch(this.url('/chat/completions'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`LLM HTTP ${resp.status}: ${text.slice(0, 500)}`);
    }

    const json = (await resp.json()) as {
      choices?: Array<{
        message?: ChatMessage;
        delta?: Partial<ChatMessage>;
      }>;
      usage?: Usage;
      model?: string;
    };

    const message = json.choices?.[0]?.message ?? {
      role: 'assistant',
      content: json.choices?.[0]?.delta?.content ?? null,
    };
    return {
      message,
      usage: json.usage ?? null,
      model: json.model ?? this.model,
    };
  }

  /**
   * 流式请求。解析 SSE，逐 delta 累积文本与工具调用。
   * 兼容 token 级真实流式，也兼容 8787 代理的“整段下发”式流式。
   */
  async chatStream(
    messages: ChatMessage[],
    tools: ToolDef[] | undefined,
    cb: StreamCallbacks,
  ): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      stream: true,
    };
    if (tools && tools.length) body.tools = tools;

    const resp = await fetch(this.url('/chat/completions'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      throw new Error(`LLM HTTP ${resp.status}: ${text.slice(0, 500)}`);
    }

    let fullText = '';
    const toolCalls: ToolCall[] = [];
    let usage: Usage | null = null;
    let model = this.model;

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const flushToolCall = (call: ToolCall) => {
      cb.onToolCall?.(call);
      const existing = toolCalls.find((t) => t.id === call.id);
      if (existing) {
        existing.function.name += call.function.name;
        existing.function.arguments += call.function.arguments;
      } else {
        toolCalls.push(call);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        let chunk: Record<string, unknown>;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0];
        if (!choice) continue;
        const delta = (choice.delta ?? {}) as Partial<ChatMessage> & {
          reasoning_content?: string;
          reasoning?: string;
        };
        // 推理流：DeepSeek 用 reasoning_content，部分网关用 reasoning。
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === 'string' && reasoning) {
          cb.onReasoning?.(reasoning);
        }
        if (typeof delta.content === 'string' && delta.content) {
          fullText += delta.content;
          cb.onText?.(delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const call: ToolCall = {
            id: tc.id ?? `call_${toolCalls.length}`,
            type: 'function',
            function: {
              name: tc.function?.name ?? '',
              arguments: tc.function?.arguments ?? '',
            },
          };
          flushToolCall(call);
        }
        if (chunk.usage) {
          usage = chunk.usage as Usage;
          cb.onUsage?.(usage);
        }
        if (typeof chunk.model === 'string') model = chunk.model;
      }
    }

    const message: ChatMessage = {
      role: 'assistant',
      content: fullText || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    };
    return { message, usage, model };
  }
}
