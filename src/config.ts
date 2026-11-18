import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ModelEntry {
  id: string;
  label: string;
  /** 是否支持视觉（图片多模态输入）。 */
  vision?: boolean;
}

export interface McpServerConfig {
  name: string;
  /** 传输类型：stdio（默认）或 http（streamable HTTP）。 */
  type?: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http 传输的 endpoint URL。 */
  url?: string;
  /** http 传输的额外请求头。 */
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface PermissionPolicyConfig {
  allowTools?: string[];
  denyTools?: string[];
  askTools?: string[];
  allowPaths?: string[];
  denyPaths?: string[];
}

export interface AgentConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  maxSteps: number;
  models: ModelEntry[];
  homeDir: string;
  sessionDir: string;
  mcpServers: McpServerConfig[];
  /** 是否拦截危险命令并确认（默认 true）。 */
  confirmDangerous: boolean;
  /** 自动放行所有危险命令（--yes / /auto）。 */
  autoApprove: boolean;
  /** 上下文压缩阈值（消息字符数近似）。 */
  compactThreshold: number;
  /** 细粒度权限策略。 */
  permission?: PermissionPolicyConfig;
  /** 工具并行执行的并发上限（默认 4）。 */
  toolConcurrency: number;
}

const DEFAULT_MODELS: ModelEntry[] = [
  { id: 'thub-auto', label: 'thub-auto（自动路由，默认）' },
  { id: 'deepseek-flash', label: 'DeepSeek Flash（快，1M 上下文）' },
  { id: 'glm-5.3-flash', label: 'GLM-5.3 Flash（Z.ai，支持视觉）', vision: true },
];

function defaultConfig(): AgentConfig {
  const homeDir = path.join(os.homedir(), '.local', 'share', 'ds-agent');
  return {
    baseURL: process.env.DSA_BASE_URL ?? 'http://127.0.0.1:8787/v1',
    apiKey: process.env.DSA_API_KEY ?? 'local-zai-fallback-proxy',
    model: process.env.DSA_MODEL ?? 'thub-auto',
    maxTokens: 8192,
    maxSteps: 60,
    models: DEFAULT_MODELS,
    homeDir,
    sessionDir: path.join(homeDir, 'sessions'),
    mcpServers: [],
    confirmDangerous: true,
    autoApprove: false,
    compactThreshold: 200_000,
    toolConcurrency: 4,
  };
}

function loadConfigFile(): Partial<AgentConfig> {
  const p = path.join(os.homedir(), '.config', 'ds-agent', 'config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return raw && typeof raw === 'object' ? (raw as Partial<AgentConfig>) : {};
  } catch {
    return {};
  }
}

export function loadConfig(): AgentConfig {
  const base = defaultConfig();
  const file = loadConfigFile();
  const cfg: AgentConfig = {
    ...base,
    ...file,
    models: Array.isArray(file.models) && file.models.length ? file.models : base.models,
    mcpServers: Array.isArray(file.mcpServers) ? file.mcpServers : base.mcpServers,
  };
  fs.mkdirSync(cfg.sessionDir, { recursive: true });
  return cfg;
}

export function modelSupportsVision(cfg: AgentConfig): boolean {
  return cfg.models.some((m) => m.id === cfg.model && m.vision);
}
