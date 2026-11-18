import { Agent } from './agent.js';
import { LLMClient } from '../llm/client.js';
import { stringifyResult, type Tool } from '../tools/types.js';

export interface SubagentResult {
  ok: boolean;
  output: string;
  steps: number;
}

export interface TaskToolOptions {
  client: LLMClient;
  tools: Tool[];
  systemPrompt: string;
  /** 危险操作确认回调（透传给子 agent）。 */
  confirm?: (question: string) => Promise<boolean>;
  /** 自动放行危险命令（透传给子 agent）。 */
  autoApprove?: boolean;
}

/**
 * 派发子 agent：复用同一个 LLM 客户端与工具集，但用独立消息历史，
 * 完成子任务后返回最终文本（不把子 agent 的过程细节塞回父上下文）。
 */
export async function runSubagent(opts: {
  client: LLMClient;
  tools: Tool[];
  systemPrompt: string;
  cwd: string;
  task: string;
  maxSteps?: number;
  confirm?: (question: string) => Promise<boolean>;
  autoApprove?: boolean;
}): Promise<SubagentResult> {
  const sub = new Agent({
    client: opts.client,
    tools: opts.tools,
    systemPrompt: `${opts.systemPrompt}\n\n你是被父 agent 派发的子 agent。独立完成指定子任务，只返回最终结果摘要，不要与用户直接对话。`,
    maxSteps: opts.maxSteps ?? 20,
    confirm: opts.confirm,
  });
  sub.setAutoApprove(opts.autoApprove ?? false);
  try {
    const output = await sub.run(opts.task, opts.cwd);
    return { ok: true, output, steps: sub.history.length };
  } catch (err) {
    return { ok: false, output: `子 agent 失败: ${(err as Error).message}`, steps: 0 };
  }
}

/** 生成 task 工具：允许父 agent 派发子任务。 */
export function makeTaskTool(opts: TaskToolOptions): Tool {
  return {
    name: 'task',
    description:
      '派发一个子 agent 独立完成子任务并返回摘要。适合并行化可独立的调查/生成工作，避免把过程细节塞满主上下文。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '子任务的完整描述（自包含）' },
      },
      required: ['task'],
    },
    async execute(args, ctx) {
      const task = String(args.task ?? '');
      if (!task.trim()) return '空任务';
      const result = await runSubagent({
        client: opts.client,
        tools: opts.tools,
        systemPrompt: opts.systemPrompt,
        cwd: ctx.cwd,
        task,
        confirm: opts.confirm,
        autoApprove: opts.autoApprove,
      });
      return stringifyResult(result.output, 8000);
    },
  };
}
