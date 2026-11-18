// Ink TUI 入口：把 Agent 的事件流桥接到 UiModel，再用 Ink 渲染。
import React from 'react';
import { render } from 'ink';
import App from './App.js';
import { UiModel } from './model.js';
import { STARTUP_TIPS } from './logo.js';
import type { AgentConfig } from '../../config.js';
import { LLMClient } from '../../llm/client.js';
import { Agent } from '../../agent/agent.js';
import {
  createSession,
  listSessions,
  loadSession,
  saveSession,
  type Session,
} from '../../agent/session.js';
import { buildSystemPrompt } from '../../agent/system-prompt.js';
import { defaultSkillDirs, makeSkillTool, scanSkills, skillsOverview } from '../../agent/skills.js';
import { makeTaskTool } from '../../agent/subagent.js';
import { makeBashTool } from '../../tools/bash.js';
import { editTool, lsTool, readTool, writeTool } from '../../tools/fs.js';
import { grepTool } from '../../tools/grep.js';
import { webFetchTool } from '../../tools/web.js';
import { expandAtRefs } from '../../agent/at-refs.js';
import { resolvePolicy } from '../../agent/permissions.js';
import { generateTitle } from '../../agent/title.js';
import { McpClient } from '../../mcp/client.js';
import { modelSupportsVision } from '../../config.js';
import type { Tool } from '../../tools/types.js';

export interface TuiOptions {
  resumeId?: string;
  plan?: boolean;
  auto?: boolean;
}

function baseTools(): Tool[] {
  return [makeBashTool(), readTool, writeTool, editTool, lsTool, grepTool, webFetchTool];
}

async function startMcpServers(
  cfg: AgentConfig,
): Promise<{ tools: Tool[]; clients: McpClient[]; notes: string[] }> {
  const tools: Tool[] = [];
  const clients: McpClient[] = [];
  const notes: string[] = [];
  for (const server of cfg.mcpServers.filter((s) => s.enabled !== false)) {
    const client = new McpClient(server);
    try {
      await client.start();
      tools.push(...client.getTools());
      clients.push(client);
      notes.push(`MCP ${server.name}: ${client.getTools().length} 个工具`);
    } catch (err) {
      notes.push(`MCP ${server.name}: 启动失败 - ${(err as Error).message}`);
    }
  }
  return { tools, clients, notes };
}

/** 取几条随机启动提示（不同会话不完全一样）。 */
function pickTips(n = 2): string[] {
  const pool = [...STARTUP_TIPS];
  const out: string[] = [];
  for (let i = 0; i < n && pool.length; i++) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}

/** 根据工具名与参数生成一句「正在做什么」。 */
function describeTool(name: string, args: Record<string, unknown>): string {
  const p = typeof args.path === 'string' ? args.path : '';
  const cmd = typeof args.command === 'string' ? args.command : '';
  const short = (s: string, n = 48) => (s.length > n ? s.slice(0, n) + '…' : s);
  switch (name) {
    case 'bash':
      return `执行命令 ${short(cmd)}`;
    case 'read':
      return `读取 ${short(p)}`;
    case 'write':
      return `写入 ${short(p)}`;
    case 'edit':
      return `修改 ${short(p)}`;
    case 'ls':
      return `列出 ${short(p || '目录')}`;
    case 'grep':
      return `搜索 ${short(String(args.pattern ?? ''))}`;
    case 'webfetch':
      return `抓取 ${short(String(args.url ?? ''))}`;
    case 'task':
      return '派发子 agent 处理子任务';
    case 'skill':
      return `加载 skill ${short(String(args.name ?? ''))}`;
    default:
      return `调用 ${name}`;
  }
}

export async function startInkTui(cfg: AgentConfig, opts: TuiOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const client = new LLMClient({
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey,
    model: cfg.model,
    maxTokens: cfg.maxTokens,
  });

  const model = new UiModel({
    model: cfg.model,
    planMode: opts.plan ?? false,
    autoApprove: opts.auto ?? cfg.autoApprove,
  });

  const { tools: mcpTools, clients: mcpClients, notes: mcpNotes } = await startMcpServers(cfg);

  const skills = scanSkills(defaultSkillDirs(cwd, cfg.homeDir));
  let systemPrompt = buildSystemPrompt(cwd);
  const overview = skillsOverview(skills);
  if (overview) systemPrompt += overview;
  if (mcpTools.length) {
    systemPrompt += `\n## 外部 MCP 工具\n${mcpTools.map((t) => t.name).join('\n')}`;
  }

  let autoApprove = opts.auto ?? cfg.autoApprove;
  const confirm = (q: string): Promise<boolean> =>
    autoApprove ? Promise.resolve(true) : model.askConfirm(q);

  const staticTools = baseTools();
  const tools: Tool[] = [
    ...staticTools,
    makeTaskTool({ client, tools: staticTools, systemPrompt, confirm, autoApprove }),
    ...mcpTools,
    ...(skills.length ? [makeSkillTool(skills)] : []),
  ];

  // 启动横幅（logo + 名称 + 模型/模式/目录 + 提示）：始终排在最前
  model.showBanner({
    model: cfg.model,
    cwd,
    planMode: opts.plan ?? false,
    autoApprove,
    tips: pickTips(2),
  });
  for (const n of mcpNotes) model.addStatus(n, 'info');

  let session: Session;
  if (opts.resumeId) {
    const loaded = loadSession(cfg.sessionDir, opts.resumeId);
    if (!loaded) {
      console.error(`未找到会话 ${opts.resumeId}`);
      process.exit(1);
    }
    session = loaded;
    model.replay(session.messages);
    model.addStatus(`已恢复会话 ${session.meta.id}${session.meta.title ? ` · ${session.meta.title}` : ''}`, 'success');
  } else {
    session = createSession(cwd, cfg.model, '');
  }

  // 工具运行中 id 栈：同名工具并发时仍能正确配对 output/end 事件
  const toolIdStack = new Map<string, string[]>();
  let currentAssistantId: string | null = null;
  let currentReasoningId: string | null = null;

  // 本轮统计
  let turnStart = 0;
  let turnSteps = 0;
  let turnToolCount = 0;
  let tokensIn = 0;
  let tokensOut = 0;

  const agent = new Agent({
    client,
    tools,
    systemPrompt,
    maxSteps: cfg.maxSteps,
    confirm,
    compactThreshold: cfg.compactThreshold,
    planMode: opts.plan ?? false,
    permission: resolvePolicy(cwd, cfg.permission),
    toolConcurrency: cfg.toolConcurrency,
    events: {
      onStep: (step) => {
        turnSteps = step;
        model.setProgress(step, '正在思考');
      },
      onReasoning: (delta) => {
        if (!currentReasoningId) {
          currentReasoningId = model.beginReasoning();
          model.setProgress(turnSteps, '思考中');
        }
        model.appendReasoning(currentReasoningId, delta);
      },
      onAssistantText: (delta) => {
        // 一旦开始输出正文，思考流即封口
        if (currentReasoningId) {
          model.endReasoning(currentReasoningId);
          currentReasoningId = null;
        }
        if (!currentAssistantId) {
          currentAssistantId = model.beginAssistant();
          model.setProgress(turnSteps, '正在回复');
        }
        model.addStreamed(delta.length);
        model.appendAssistant(currentAssistantId, delta);
      },
      onToolStart: (name, args) => {
        currentAssistantId = null; // 进入工具阶段，流式文本封口
        if (currentReasoningId) {
          model.endReasoning(currentReasoningId);
          currentReasoningId = null;
        }
        if (name === 'task') {
          model.setProgress(turnSteps, '子 agent 处理中');
          return;
        }
        if (name === 'compact') {
          model.addStatus(`已压缩早期上下文（${(args as { dropped?: number }).dropped ?? '?'} 条）`, 'info');
          return;
        }
        turnToolCount += 1;
        model.setProgress(turnSteps, describeTool(name, args));
        const id = model.beginTool(name, args);
        const stack = toolIdStack.get(name) ?? [];
        stack.push(id);
        toolIdStack.set(name, stack);
      },
      onAssistantEnd: () => {
        // 一段助手文本流结束就立刻封口，否则末尾的 ▌ 光标会一直留着
        if (currentAssistantId) {
          model.endAssistant(currentAssistantId);
          currentAssistantId = null;
        }
        if (currentReasoningId) {
          model.endReasoning(currentReasoningId);
          currentReasoningId = null;
        }
      },
      onToolOutput: (name, chunk) => {
        const stack = toolIdStack.get(name);
        const id = stack && stack.length ? stack[stack.length - 1] : undefined;
        if (id) model.appendToolOutput(id, chunk);
      },
      onToolEnd: (name, output) => {
        const stack = toolIdStack.get(name);
        const id = stack && stack.length ? stack.pop()! : undefined;
        if (id) {
          const failed = /^工具执行异常|^命令执行失败|\[exit code: [1-9]/.test(output);
          model.endTool(id, output, failed);
        }
        model.setProgress(turnSteps, '继续处理');
      },
      onUsage: (u) => {
        tokensIn += u.prompt;
        tokensOut += u.completion;
      },
    },
  });
  agent.setAutoApprove(autoApprove);

  const runTurn = async (text: string) => {
    if (model.get().busy) return;
    turnStart = Date.now();
    turnSteps = 0;
    turnToolCount = 0;
    tokensIn = 0;
    tokensOut = 0;
    model.markTurnStart();
    model.setBusy(true);
    model.addUser(text);
    try {
      const content = expandAtRefs(text, cwd, modelSupportsVision(cfg));
      await agent.run(text, cwd, content);
      currentAssistantId = null;
      currentReasoningId = null;
      session.messages = agent.history;
      if (!session.meta.title) {
        session.meta.title = await generateTitle(client, text);
      }
      saveSession(cfg.sessionDir, session);
      // 先结束 busy 再追加统计行，避免渲染出「统计 + 还在转圈的进度行」的中间帧
      model.finishTurn();
      model.addStats({
        elapsedMs: Date.now() - turnStart,
        finishedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        steps: turnSteps,
        tools: turnToolCount,
        tokensIn,
        tokensOut,
      });
    } catch (err) {
      model.finishTurn();
      model.addStatus(`错误: ${(err as Error).message}`, 'error');
    }
  };

  const onQuit = () => {
    saveSession(cfg.sessionDir, session);
    for (const c of mcpClients) void c.stop();
    process.exit(0);
  };

  const ink = render(
    React.createElement(App, {
      model,
      onSubmit: (t) => void runTurn(t),
      onCancel: () => agent.cancel(),
      onModelSet: (id) => {
        client.model = id;
        cfg.model = id;
        model.setModel(id);
        session.meta.model = id;
        model.addStatus(`已切换模型 → ${id}`, 'success');
      },
      onModelList: () => {
        const list = cfg.models.map((m) => `${m.id}${m.vision ? '（视觉）' : ''}`).join(' · ');
        model.addStatus(`可选模型：${list}`, 'info');
      },
      onPlan: () => {
        agent.setPlanMode(!agent.getPlanMode());
        model.setPlanMode(agent.getPlanMode());
        model.addStatus(agent.getPlanMode() ? '计划模式已开启（只读调查）' : '计划模式已关闭', 'success');
      },
      onAuto: () => {
        autoApprove = !autoApprove;
        agent.setAutoApprove(autoApprove);
        model.setAutoApprove(autoApprove);
        model.addStatus(autoApprove ? '危险命令自动放行：开' : '危险命令自动放行：关', 'success');
      },
      onClear: () => {
        agent.setHistory([]);
        session.messages = [];
        model.clear();
        model.addStatus('上下文已清空', 'success');
        saveSession(cfg.sessionDir, session);
      },
      onToolList: () => {
        const names = tools.map((t) => t.name).sort().join(' · ');
        model.addStatus(`当前工具（${tools.length}）：${names}`, 'info');
      },
      onSessionList: () => {
        const list = listSessions(cfg.sessionDir).slice(0, 10);
        if (!list.length) {
          model.addStatus('暂无历史会话', 'info');
          return;
        }
        const rows = list.map(
          (s) => `${s.id}  ${s.updatedAt.slice(0, 16).replace('T', ' ')}  ${s.title || '(无标题)'}`,
        );
        model.addStatus(`历史会话（最近 ${list.length} 个，用 --resume <id> 恢复）：\n${rows.join('\n')}`, 'info');
      },
      onQuit,
    }),
  );

  // 兜底：Ctrl+C 退出
  process.on('SIGINT', () => {
    ink.unmount();
    onQuit();
  });

  await ink.waitUntilExit();
}
