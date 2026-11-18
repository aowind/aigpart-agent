import { LLMClient } from '../llm/client.js';
import {
  contentToText,
  type ChatMessage,
  type ToolCall,
  type ToolDef,
} from '../llm/types.js';
import {
  toToolDef,
  type Tool,
  type ToolContext,
} from '../tools/types.js';
import {
  decide,
  resolvePolicy,
  type PermissionDecision,
  type PermissionPolicy,
} from './permissions.js';

export interface AgentEvents {
  onAssistantText?: (delta: string) => void;
  /** 模型的思考/推理流（reasoning_content）。 */
  onReasoning?: (delta: string) => void;
  onToolStart?: (name: string, args: Record<string, unknown>) => void;
  onToolEnd?: (name: string, output: string) => void;
  /** 工具内部回显的补充提示（如“执行: xxx”）。 */
  onNote?: (text: string) => void;
  /** 工具执行过程中的增量输出（如 bash 实时 stdout）。 */
  onToolOutput?: (name: string, chunk: string) => void;
  /** 一条 assistant 消息的文本流结束（进入工具执行或本轮结束）。 */
  onAssistantEnd?: () => void;
  onStep?: (step: number) => void;
  /** 每次模型请求返回的 token 用量（累加到本轮统计）。 */
  onUsage?: (usage: { prompt: number; completion: number }) => void;
  /** 进入/退出 plan mode 时通知 UI。 */
  onPlanMode?: (active: boolean) => void;
}

export interface AgentOptions {
  client: LLMClient;
  tools: Tool[];
  systemPrompt: string;
  maxSteps?: number;
  events?: AgentEvents;
  /** 额外塞进 tools 的 skill 读取工具（惰性）。 */
  extraTools?: Tool[];
  /** 危险操作确认回调（null 表示不确认，直接放行）。 */
  confirm?: (question: string) => Promise<boolean>;
  /** 上下文压缩阈值（消息字符数近似）。 */
  compactThreshold?: number;
  /** 是否启用压缩（默认 true）。 */
  compaction?: boolean;
  /** 是否默认进入 plan mode（默认 false）。 */
  planMode?: boolean;
  /** 细粒度权限策略。 */
  permission?: PermissionPolicy;
  /** 工具并行执行的并发上限（默认 4，1 表示顺序执行）。 */
  toolConcurrency?: number;
}

const PLAN_SYSTEM_SUFFIX = `\n\n## 当前处于计划模式
你现在处于「计划模式」：只允许使用只读工具（ls/read/grep/webfetch/skill 及 MCP 只读工具）来调查，然后给出执行计划，不要做任何修改。
计划里要说明：目标、步骤、涉及的文件、风险。用户批准后，你会退出计划模式并按计划执行。`;

export class Agent {
  private client: LLMClient;
  private tools: Tool[];
  private toolDefs: ToolDef[];
  private systemPrompt: string;
  private maxSteps: number;
  private events: AgentEvents;
  private confirm: ((q: string) => Promise<boolean>) | null;
  private compactThreshold: number;
  private compaction: boolean;
  private planMode: boolean;
  private autoApprove = false;
  private permission: PermissionPolicy;
  private toolConcurrency: number;

  private messages: ChatMessage[] = [];
  private toolMap: Map<string, Tool>;
  private compactionNote = '';
  private cancelled = false;

  constructor(opts: AgentOptions) {
    this.client = opts.client;
    this.tools = [...opts.tools, ...(opts.extraTools ?? [])];
    this.toolDefs = this.tools.map(toToolDef);
    this.toolMap = new Map(this.tools.map((t) => [t.name, t]));
    this.systemPrompt = opts.systemPrompt;
    this.maxSteps = opts.maxSteps ?? 60;
    this.events = opts.events ?? {};
    this.confirm = opts.confirm ?? null;
    this.compactThreshold = opts.compactThreshold ?? 200_000;
    this.compaction = opts.compaction ?? true;
    this.planMode = opts.planMode ?? false;
    this.permission = opts.permission ?? resolvePolicy(process.cwd());
    this.toolConcurrency = Math.max(1, opts.toolConcurrency ?? 4);
  }

  /** 从历史消息重建（恢复会话）。 */
  setHistory(messages: ChatMessage[]): void {
    this.messages = [...messages];
  }

  get history(): ChatMessage[] {
    return this.messages;
  }

  setPlanMode(active: boolean): void {
    if (this.planMode === active) return;
    this.planMode = active;
    this.events.onPlanMode?.(active);
  }

  getPlanMode(): boolean {
    return this.planMode;
  }

  setAutoApprove(active: boolean): void {
    this.autoApprove = active;
  }

  getAutoApprove(): boolean {
    return this.autoApprove;
  }

  /** 覆盖运行时事件回调（供 TUI 每轮注入新的渲染回调）。 */
  setEvents(events: AgentEvents): void {
    this.events = events;
  }

  /** 请求中断当前 run 的循环（在下一步/下一个工具前生效）。 */
  cancel(): void {
    this.cancelled = true;
  }

  /** 注入一条用户消息并跑完整个 agent loop，返回最终助手文本。 */
  async run(userText: string, cwd: string, content?: ChatMessage['content']): Promise<string> {
    this.cancelled = false;
    this.messages.push({
      role: 'user',
      content: content ?? userText,
    });
    return this.loop(cwd);
  }

  /** 继续一个已注入用户消息的 loop（供子 agent / plan 退出后复用）。 */
  private async loop(cwd: string): Promise<string> {
    let finalText = '';

    for (let step = 0; step < this.maxSteps; step++) {
      if (this.cancelled) {
        this.cancelled = false;
        return finalText ? finalText + '\n\n[已中断]' : '[已中断]';
      }
      this.events.onStep?.(step + 1);
      const requestMessages = this.buildRequestMessages();
      const result = await this.client.chatStream(
        requestMessages,
        this.toolDefs,
        {
          onText: (delta) => {
            finalText += delta;
            this.events.onAssistantText?.(delta);
          },
          onReasoning: (delta) => this.events.onReasoning?.(delta),
          onUsage: (u) =>
            this.events.onUsage?.({
              prompt: u.prompt_tokens ?? 0,
              completion: u.completion_tokens ?? 0,
            }),
        },
      );
      const msg = result.message;

      if (msg.content && !msg.tool_calls?.length) {
        finalText = finalText || contentToText(msg.content);
      }
      this.messages.push(msg);
      this.events.onAssistantEnd?.();

      const calls = msg.tool_calls ?? [];
      if (!calls.length) {
        return finalText;
      }

      // 执行所有工具调用（并行，有并发上限；工具结果按原始顺序追加）
      const results = await this.executeTools(calls, cwd);
      this.messages.push(...results);

      await this.maybeCompact();
    }

    return finalText || '(达到最大步数，未产出最终文本)';
  }

  /** 组装请求消息：system（+ plan 后缀 + 压缩摘要）+ 历史。 */
  private buildRequestMessages(): ChatMessage[] {
    let system = this.systemPrompt;
    if (this.compactionNote) {
      system += `\n\n[已压缩的历史摘要]\n${this.compactionNote}`;
    }
    if (this.planMode) {
      system += PLAN_SYSTEM_SUFFIX;
    }
    return [{ role: 'system', content: system }, ...this.messages];
  }

  // plan mode 允许的只读工具；不在名单里的（bash 写、write、edit、task 等）一律拦截。
  private static readonly PLAN_READONLY = new Set(['ls', 'read', 'grep', 'webfetch', 'skill']);

  /** 并行执行一批工具调用，保持原始顺序返回 tool 消息。 */
  private async executeTools(calls: ToolCall[], cwd: string): Promise<ChatMessage[]> {
    const outputs = new Array<string>(calls.length);
    let nextIndex = 0;

    // worker 池：每个 worker 循环领取下一个未执行的下标，直到全部完成。
    // nextIndex++ 在单线程事件循环中是原子的，无竞态。
    const worker = async (): Promise<void> => {
      while (nextIndex < calls.length) {
        const i = nextIndex++;
        outputs[i] = await this.executeTool(calls[i], cwd);
      }
    };

    const workerCount = Math.min(this.toolConcurrency, calls.length);
    await Promise.all(
      Array.from({ length: workerCount }, () => worker()),
    );

    return calls.map((call, i) => ({
      role: 'tool' as const,
      tool_call_id: call.id,
      name: call.function.name,
      content: outputs[i],
    }));
  }

  private async executeTool(call: ToolCall, cwd: string): Promise<string> {
    const tool = this.toolMap.get(call.function.name);
    if (!tool) {
      return `错误：未知工具 ${call.function.name}`;
    }
    if (this.planMode && !Agent.PLAN_READONLY.has(tool.name)) {
      return `[计划模式] 已拦截 ${tool.name}。当前只允许只读调查（ls/read/grep/webfetch/skill），请先给出计划，待用户批准退出计划模式后再执行。`;
    }
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      args = { _raw: call.function.arguments };
    }

    // 细粒度权限判定
    const decision = decide(this.permission, tool.name, cwd, args);
    if (decision === 'deny') {
      return `[权限] 已拒绝工具 ${tool.name}（命中 denyTools/denyPaths 策略）。`;
    }
    if (decision === 'ask') {
      const ok = await this.confirm?.(
        `工具 ${tool.name} 请求访问 ${String(args.path ?? args.command ?? '')}，是否允许？`,
      );
      if (!ok) return `[权限] 用户拒绝了工具 ${tool.name} 的本次调用。`;
    }

    const ctx: ToolContext = {
      cwd,
      note: (text) => this.events.onNote?.(text),
      onOutput: (chunk) => this.events.onToolOutput?.(tool.name, chunk),
      confirm: this.confirm
        ? (q) => (this.autoApprove ? Promise.resolve(true) : this.confirm!(q))
        : undefined,
      autoApprove: this.autoApprove,
    };
    this.events.onToolStart?.(tool.name, args);
    try {
      const output = await tool.execute(args, ctx);
      this.events.onToolEnd?.(tool.name, output);
      return output;
    } catch (err) {
      const msg = `工具执行异常: ${(err as Error).message}`;
      this.events.onToolEnd?.(tool.name, msg);
      return msg;
    }
  }

  /** 消息总量超阈值时，调用模型把早期消息压缩成摘要。 */
  private async maybeCompact(): Promise<void> {
    if (!this.compaction) return;
    const total = this.messages.reduce(
      (n, m) =>
        n + contentToText(m.content).length + JSON.stringify(m.tool_calls ?? '').length,
      0,
    );
    if (total < this.compactThreshold) return;

    // 保留最后 6 条，其余压成摘要
    const kept = this.messages.slice(-6);
    const dropped = this.messages.slice(0, -6);
    const summary = await this.summarize(dropped);
    this.compactionNote = `以下是对更早对话（${dropped.length} 条消息）的压缩摘要，涉及的文件与结论仍然有效：\n${summary}`;
    this.messages = kept;
    this.events.onToolStart?.('compact', { dropped: dropped.length });
  }

  /** 用模型把一批早期消息压缩成摘要文本。失败则退回朴素截断。 */
  private async summarize(messages: ChatMessage[]): Promise<string> {
    const text = messages
      .map((m) => {
        const role = m.role === 'assistant' ? '助手' : m.role === 'tool' ? '工具结果' : '用户';
        const body = contentToText(m.content);
        return `[${role}] ${body}`;
      })
      .join('\n')
      .slice(-20000);
    try {
      const result = await this.client.chat([
        {
          role: 'system',
          content:
            '把下面的对话记录压缩成一段简洁摘要。保留：用户的目标、已做出的关键决策、已改动的文件、仍待完成的事项。丢弃工具执行的中间输出。用中文。',
        },
        { role: 'user', content: text },
      ]);
      const out = contentToText(result.message.content);
      return out.slice(0, 4000) || '(摘要失败)';
    } catch {
      return '(摘要失败，回退)';
    }
  }
}
