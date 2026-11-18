// Ink TUI 的展示行类型：用户消息、助手文本、思考、工具块、状态行、启动横幅、统计。
export type DisplayLine =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string; streaming: boolean }
  /** 模型的思考/推理流（部分模型经 reasoning_content 返回）。 */
  | { id: string; kind: 'reasoning'; text: string; streaming: boolean }
  | {
      id: string;
      kind: 'tool';
      name: string;
      argsBrief: string;
      output: string;
      done: boolean;
      failed?: boolean;
      startedAt: number;
      endedAt?: number;
    }
  | { id: string; kind: 'status'; text: string; tone: 'info' | 'error' | 'success' }
  /** 启动横幅：logo、名称、模型、模式、目录、提示。 */
  | {
      id: string;
      kind: 'banner';
      model: string;
      cwd: string;
      planMode: boolean;
      autoApprove: boolean;
      tips: string[];
    }
  /** 一轮任务结束后的耗时与用量统计。 */
  | {
      id: string;
      kind: 'stats';
      elapsedMs: number;
      finishedAt: string;
      steps: number;
      tools: number;
      tokensIn: number;
      tokensOut: number;
    };

export interface UiState {
  /** 已封口的历史行（进 Ink 的 Static，只增不减）。 */
  completed: DisplayLine[];
  /** 当前流式中的行（助手文本、思考、运行中的工具），动态渲染。 */
  active: DisplayLine[];
  model: string;
  planMode: boolean;
  autoApprove: boolean;
  busy: boolean;
  /** 输入框占位/提示文字。 */
  hint: string;
  /** 待确认的问题（非 null 时 TUI 拦截 y/n）。 */
  confirmQuestion: string | null;
  /** 当前 agent 步数（1 起，0 表示本轮未开始）。 */
  step: number;
  /** 当前正在做的事，如「正在读取 src/index.ts」。 */
  phase: string;
  /** 本轮开始时间戳（ms）。 */
  turnStartedAt: number | null;
  /** 本轮已流式输出的字符数（近似 token 进度）。 */
  streamed: number;
}

let seq = 0;
export function nextId(): string {
  seq += 1;
  return `l${seq}-${Math.random().toString(36).slice(2, 6)}`;
}
