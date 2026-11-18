import { loadConfig, type AgentConfig } from './config.js';
import { LLMClient } from './llm/client.js';
import { Agent } from './agent/agent.js';
import { listSessions, loadSession, saveSession } from './agent/session.js';
import { buildSystemPrompt } from './agent/system-prompt.js';
import { defaultSkillDirs, makeSkillTool, scanSkills, skillsOverview } from './agent/skills.js';
import { makeTaskTool } from './agent/subagent.js';
import { makeBashTool } from './tools/bash.js';
import { editTool, lsTool, readTool, writeTool } from './tools/fs.js';
import { grepTool } from './tools/grep.js';
import { webFetchTool } from './tools/web.js';
import { expandAtRefs } from './agent/at-refs.js';
import { resolvePolicy } from './agent/permissions.js';
import { generateTitle } from './agent/title.js';
import { McpClient } from './mcp/client.js';
import type { Tool } from './tools/types.js';
import { startInkTui } from './ui/ink/index.js';

interface CliArgs {
  resume?: string;
  model?: string;
  maxSteps?: number;
  prompt?: string;
  list?: boolean;
  plan?: boolean;
  auto?: boolean;
  titles?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--resume' || a === '-r') args.resume = argv[++i];
    else if (a === '--model' || a === '-m') args.model = argv[++i];
    else if (a === '--max-steps') args.maxSteps = Number(argv[++i]);
    else if (a === '--list' || a === '-l') args.list = true;
    else if (a === '--titles') args.titles = true;
    else if (a === '--plan' || a === '-p') args.plan = true;
    else if (a === '--auto' || a === '--yes' || a === '-y') args.auto = true;
    else if (a === '--help' || a === '-h') {
      printCliHelp();
      process.exit(0);
    } else if (!args.prompt && !a.startsWith('-')) {
      args.prompt = a;
    }
  }
  return args;
}

function printCliHelp(): void {
  process.stdout.write(
    [
      'ds-agent —— 精简终端 AI 编程 agent',
      '',
      '用法：',
      '  ds-agent                      进入交互式 TUI',
      '  ds-agent "任务描述"            一次性执行（headless）',
      '  ds-agent --resume <id>        恢复历史会话',
      '  ds-agent --list               列出历史会话',
      '  ds-agent --titles             为缺标题的历史会话批量生成标题',
      '  ds-agent --model <id>         指定模型',
      '  ds-agent --max-steps <n>      每轮最多工具步数',
      '  ds-agent --plan               进入计划模式',
      '  ds-agent --auto / --yes       自动放行危险命令',
      '',
    ].join('\n'),
  );
}

function baseTools(): Tool[] {
  return [makeBashTool(), readTool, writeTool, editTool, lsTool, grepTool, webFetchTool];
}

/** headless 一次性执行。 */
async function runOnce(
  cfg: AgentConfig,
  prompt: string,
  opts: { resumeId?: string; plan?: boolean; auto?: boolean },
): Promise<void> {
  const client = new LLMClient({
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey,
    model: cfg.model,
    maxTokens: cfg.maxTokens,
  });
  const cwd = process.cwd();
  const autoApprove = opts.auto ?? cfg.autoApprove;
  const confirm = async (q: string): Promise<boolean> => {
    if (autoApprove) return true;
    return false; // headless 非交互，危险命令默认拒绝
  };
  const { tools: mcpTools, clients: mcpClients, notes: mcpNotes } = await startMcpServers(cfg);

  const skills = scanSkills(defaultSkillDirs(cwd, cfg.homeDir));
  let systemPrompt = buildSystemPrompt(cwd);
  const overview = skillsOverview(skills);
  if (overview) systemPrompt += overview;
  if (mcpTools.length) {
    systemPrompt += `\n## 外部 MCP 工具\n${mcpTools.map((t) => t.name).join('\n')}`;
  }

  const staticTools = baseTools();
  const tools: Tool[] = [
    ...staticTools,
    makeTaskTool({ client, tools: staticTools, systemPrompt, confirm, autoApprove }),
    ...mcpTools,
    ...(skills.length ? [makeSkillTool(skills)] : []),
  ];

  for (const n of mcpNotes) process.stderr.write(`${n}\n`);

  const agent = new Agent({
    client,
    tools,
    systemPrompt,
    maxSteps: cfg.maxSteps,
    confirm,
    compactThreshold: cfg.compactThreshold,
    planMode: opts.plan,
    permission: resolvePolicy(cwd, cfg.permission),
    toolConcurrency: cfg.toolConcurrency,
    events: {
      onAssistantText: (d) => process.stdout.write(d),
      onToolOutput: (_name, chunk) => process.stdout.write(chunk),
      onToolStart: (name) => {
        if (name === 'task' || name === 'compact') return;
        process.stdout.write(`\n[${name}] `);
      },
    },
  });
  agent.setAutoApprove(autoApprove);

  try {
    const content = expandAtRefs(prompt, cwd, modelSupportsVision(cfg));
    const answer = await agent.run(prompt, cwd, content);
    process.stdout.write('\n');
    process.stdout.write(`已保存会话\n`);
  } finally {
    await Promise.all(mcpClients.map((c) => c.stop()));
  }
}

async function startMcpServers(cfg: AgentConfig): Promise<{ tools: Tool[]; clients: McpClient[]; notes: string[] }> {
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

function modelSupportsVision(cfg: AgentConfig): boolean {
  return cfg.models.some((m) => m.id === cfg.model && m.vision);
}

/** 从会话消息里取首条用户消息的纯文本（用于补标题）。 */
function firstUserText(messages: Array<{ role: string; content: unknown }>): string {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c
        .map((p) => (p && typeof p === 'object' && (p as { type?: string }).type === 'text'
          ? String((p as { text?: string }).text ?? '')
          : ''))
        .join('');
    }
  }
  return '';
}

/** 为缺标题的历史会话批量补标题（串行，避免同时打一堆请求）。 */
async function fillMissingTitles(cfg: AgentConfig): Promise<void> {
  const client = new LLMClient({
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey,
    model: cfg.model,
    maxTokens: cfg.maxTokens,
  });
  const metas = listSessions(cfg.sessionDir);
  const targets = metas.filter((m) => !m.title);
  if (!targets.length) {
    process.stdout.write('所有会话都已有标题，无需处理。\n');
    return;
  }

  process.stdout.write(`发现 ${targets.length} 个缺标题的会话，开始生成…\n`);
  let done = 0;
  let skipped = 0;
  for (const meta of targets) {
    const session = loadSession(cfg.sessionDir, meta.id);
    if (!session) {
      skipped += 1;
      continue;
    }
    const text = firstUserText(session.messages).trim();
    if (!text) {
      // 空会话不调用模型，直接记个占位标题，免得下次又扫到
      session.meta.title = '(空会话)';
      saveSession(cfg.sessionDir, session);
      skipped += 1;
      process.stdout.write(`  ${meta.id}  (空会话，已占位)\n`);
      continue;
    }
    const title = await generateTitle(client, text);
    session.meta.title = title;
    saveSession(cfg.sessionDir, session);
    done += 1;
    process.stdout.write(`  ${meta.id}  ${title}\n`);
  }
  process.stdout.write(`完成：生成 ${done} 个，跳过 ${skipped} 个。\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  if (args.model) cfg.model = args.model;
  if (args.maxSteps && args.maxSteps > 0) cfg.maxSteps = args.maxSteps;

  if (args.list) {
    const list = listSessions(cfg.sessionDir);
    process.stdout.write(
      `历史会话：${list.map((s) => `\n  ${s.id}  ${s.updatedAt.slice(0, 16).replace('T', ' ')}  ${s.title || '(无标题)'}`).join('')}\n`,
    );
    return;
  }

  if (args.titles) {
    await fillMissingTitles(cfg);
    return;
  }

  if (args.prompt) {
    await runOnce(cfg, args.prompt, { resumeId: args.resume, plan: args.plan, auto: args.auto });
    return;
  }

  // 无 prompt：进入 Ink TUI（Claude Code 风格）
  await startInkTui(cfg, { resumeId: args.resume, plan: args.plan, auto: args.auto });
}

main().catch((err) => {
  process.stderr.write(`致命错误: ${(err as Error).message}\n`);
  process.exit(1);
});
