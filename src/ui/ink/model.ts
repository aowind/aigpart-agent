// TUI 状态模型：一个可订阅的 store，Ink 组件用 useSyncExternalStore 订阅。
import { useSyncExternalStore } from 'react';
import { nextId, type DisplayLine, type UiState } from './types.js';

type Listener = () => void;

export class UiModel {
  private state: UiState;
  private listeners = new Set<Listener>();

  constructor(initial: Partial<UiState> = {}) {
    this.state = {
      completed: [],
      active: [],
      model: 'thub-auto',
      planMode: false,
      autoApprove: false,
      busy: false,
      hint: '',
      confirmQuestion: null,
      step: 0,
      phase: '',
      turnStartedAt: null,
      streamed: 0,
      ...initial,
    };
  }

  get = (): UiState => {
    return this.state;
  };

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private set(patch: Partial<UiState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  // ------------------------------------------------------------- 行操作

  /** 把一条行从 active 移到 completed（封口）。 */
  private settle(lineId: string): void {
    const line = this.state.active.find((l) => l.id === lineId);
    if (!line) return;
    this.state = {
      ...this.state,
      active: this.state.active.filter((l) => l.id !== lineId),
      completed: [...this.state.completed, line],
    };
    this.emit();
  }

  addUser(text: string): void {
    const line: DisplayLine = { id: nextId(), kind: 'user', text };
    this.set({ completed: [...this.state.completed, line] });
  }

  /** 开启一段流式推理；返回行 id。 */
  beginReasoning(): string {
    const id = nextId();
    const line: DisplayLine = { id, kind: 'reasoning', text: '', streaming: true };
    this.set({ active: [...this.state.active, line] });
    return id;
  }

  appendReasoning(id: string, delta: string): void {
    this.set({
      active: this.state.active.map((l) =>
        l.id === id && l.kind === 'reasoning' ? { ...l, text: l.text + delta } : l,
      ),
    });
  }

  /** 开启一段流式助手文本；返回行 id。 */
  beginAssistant(): string {
    const id = nextId();
    const line: DisplayLine = { id, kind: 'assistant', text: '', streaming: true };
    this.set({ active: [...this.state.active, line] });
    return id;
  }

  appendAssistant(id: string, delta: string): void {
    this.set({
      active: this.state.active.map((l) =>
        l.id === id && l.kind === 'assistant' ? { ...l, text: l.text + delta } : l,
      ),
    });
  }

  endAssistant(id: string): void {
    this.settle(id);
  }

  /** 封口一段思考流。 */
  endReasoning(id: string): void {
    this.settle(id);
  }

  /** 结束当前流式的助手文本 / 推理（若存在），以便插入工具块。 */
  private closeStreaming(): void {
    const streaming = this.state.active.filter(
      (l) =>
        (l.kind === 'assistant' && l.streaming) || (l.kind === 'reasoning' && l.streaming),
    );
    for (const l of streaming) this.settle(l.id);
  }

  beginTool(name: string, args: Record<string, unknown>): string {
    this.closeStreaming();
    const argsBrief =
      name === 'bash' && typeof args.command === 'string'
        ? args.command.slice(0, 160)
        : Object.entries(args)
            .filter(([k]) => k !== 'note')
            .map(([k, v]) => `${k}=${String(JSON.stringify(v)).slice(0, 60)}`)
            .join('  ');
    const id = nextId();
    const line: DisplayLine = {
      id,
      kind: 'tool',
      name,
      argsBrief,
      output: '',
      done: false,
      startedAt: Date.now(),
    };
    this.set({ active: [...this.state.active, line] });
    return id;
  }

  appendToolOutput(id: string, chunk: string): void {
    this.set({
      active: this.state.active.map((l) =>
        l.id === id && l.kind === 'tool' ? { ...l, output: l.output + chunk } : l,
      ),
    });
  }

  endTool(id: string, output: string, failed = false): void {
    this.set({
      active: this.state.active.map((l) =>
        l.id === id && l.kind === 'tool'
          ? { ...l, output, done: true, failed, endedAt: Date.now() }
          : l,
      ),
    });
    this.settle(id);
  }

  addStatus(text: string, tone: 'info' | 'error' | 'success' = 'info'): void {
    const line: DisplayLine = { id: nextId(), kind: 'status', text, tone };
    this.set({ completed: [...this.state.completed, line] });
  }

  /** 启动横幅（logo、名称、模型、模式、目录、提示）。 */
  showBanner(opts: {
    model: string;
    cwd: string;
    planMode: boolean;
    autoApprove: boolean;
    tips: string[];
  }): void {
    const line: DisplayLine = { id: nextId(), kind: 'banner', ...opts };
    this.set({ completed: [...this.state.completed, line] });
  }

  /** 一轮结束后的统计块。 */
  addStats(stats: {
    elapsedMs: number;
    finishedAt: string;
    steps: number;
    tools: number;
    tokensIn: number;
    tokensOut: number;
  }): void {
    const line: DisplayLine = { id: nextId(), kind: 'stats', ...stats };
    this.set({ completed: [...this.state.completed, line] });
  }

  /** 会话恢复：把历史消息转成展示行回放。 */
  replay(
    messages: Array<{
      role: string;
      content: unknown;
      tool_calls?: Array<{ function: { name: string; arguments: string } }>;
      name?: string;
    }>,
  ): void {
    const lines: DisplayLine[] = [];
    const toText = (c: unknown): string => {
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.map((p) => (p && p.type === 'text' ? p.text : '')).join('');
      return '';
    };
    for (const m of messages) {
      if (m.role === 'user') {
        const t = toText(m.content);
        if (t) lines.push({ id: nextId(), kind: 'user', text: t });
      } else if (m.role === 'assistant') {
        const t = toText(m.content);
        if (t) lines.push({ id: nextId(), kind: 'assistant', text: t, streaming: false });
        for (const tc of m.tool_calls ?? []) {
          let brief = '';
          try {
            const a = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
            brief =
              typeof a.command === 'string'
                ? a.command.slice(0, 160)
                : Object.entries(a)
                    .map(([k, v]) => `${k}=${String(JSON.stringify(v)).slice(0, 60)}`)
                    .join('  ');
          } catch {
            brief = tc.function.arguments.slice(0, 120);
          }
          lines.push({
            id: nextId(),
            kind: 'tool',
            name: tc.function.name,
            argsBrief: brief,
            output: '',
            done: false,
            startedAt: 0,
          });
        }
      } else if (m.role === 'tool') {
        // 找最近的未填 tool 行补 output
        for (let i = lines.length - 1; i >= 0; i--) {
          const l = lines[i];
          if (l.kind === 'tool' && !l.done) {
            l.output = toText(m.content);
            l.done = true;
            break;
          }
        }
      }
    }
    // 回放时把所有 tool 行封口（历史里没有真实耗时）
    for (const l of lines) if (l.kind === 'tool') l.done = true;
    this.set({ completed: lines });
  }

  // ------------------------------------------------------------- 状态

  setModel(m: string): void {
    this.set({ model: m });
  }
  setPlanMode(v: boolean): void {
    this.set({ planMode: v });
  }
  setAutoApprove(v: boolean): void {
    this.set({ autoApprove: v });
  }
  setBusy(v: boolean): void {
    this.set({ busy: v });
  }
  setHint(v: string): void {
    this.set({ hint: v });
  }
  /** 更新当前步骤号与阶段描述（显示在底部提示行）。 */
  setProgress(step: number, phase?: string): void {
    this.set(phase === undefined ? { step } : { step, phase });
  }
  markTurnStart(): void {
    this.set({ turnStartedAt: Date.now(), step: 0, phase: '准备中', streamed: 0 });
  }
  /** 累加本轮已流式输出的字符数（进度行显示用）。 */
  addStreamed(n: number): void {
    this.set({ streamed: this.state.streamed + n });
  }
  clearProgress(): void {
    this.set({ turnStartedAt: null, step: 0, phase: '', streamed: 0 });
  }
  /** 一轮结束：一次性退出 busy 并清空进度，避免中间帧闪现空进度条。 */
  finishTurn(): void {
    this.set({ busy: false, turnStartedAt: null, step: 0, phase: '', streamed: 0 });
  }

  /** 清空当前上下文（含展示行）。 */
  clear(): void {
    this.set({ completed: [], active: [], step: 0, phase: '', turnStartedAt: null });
  }

  // ------------------------------------------------------------- 确认

  private confirmResolver: ((v: boolean) => void) | null = null;

  /** 弹出一个 [y/N] 确认，返回 Promise。供危险命令确认回调调用。 */
  askConfirm(question: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.confirmResolver = resolve;
      this.set({ confirmQuestion: question });
    });
  }

  answerConfirm(value: boolean): void {
    if (!this.confirmResolver) return;
    const r = this.confirmResolver;
    this.confirmResolver = null;
    this.set({ confirmQuestion: null });
    r(value);
  }
}

/** 订阅整个 model 的 hook。 */
export function useUiModel(model: UiModel): UiState {
  return useSyncExternalStore(model.subscribe, model.get);
}
