// OpenAI 兼容协议的消息与工具类型（DeepSeek 同款）

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON 字符串
  };
}

export interface ContentTextPart {
  type: 'text';
  text: string;
}

export interface ContentImagePart {
  type: 'image_url';
  image_url: { url: string };
}

export type ContentPart = ContentTextPart | ContentImagePart;

/** 消息内容：纯文本、多模态 part 数组、或空（tool_calls 时）。 */
export type MessageContent = string | ContentPart[] | null;

export interface ChatMessage {
  role: Role;
  content: MessageContent;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

/** 把任意 content 转成纯文本（用于压缩、摘要、回显）。 */
export function contentToText(content: MessageContent): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((p) => p.type === 'text')
    .map((p) => (p as ContentTextPart).text)
    .join('');
}

export interface FunctionDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ToolDef {
  type: 'function';
  function: FunctionDef;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface StreamCallbacks {
  onText?: (delta: string) => void;
  /** 模型的思考/推理流（reasoning_content，部分模型返回）。 */
  onReasoning?: (delta: string) => void;
  onToolCall?: (call: ToolCall) => void;
  onUsage?: (usage: Usage) => void;
}

export interface CompletionResult {
  message: ChatMessage;
  usage: Usage | null;
  model: string;
}

export interface ClientOptions {
  baseURL: string; // 例如 http://127.0.0.1:8787/v1
  apiKey: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
}
