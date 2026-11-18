// MCP 客户端门面：负责协议流程（initialize → tools/list → tools/call）与 Tool 转换。
// 底层传输（stdio / streamable HTTP）由 transport.ts 提供。
// stdio 传输进程意外退出时，本门面负责重启并重新加载工具。
import { stringifyResult, type Tool } from '../tools/types.js';
import type { McpServerConfig } from '../config.js';
import { HttpTransport, StdioTransport, type McpTransport } from './transport.js';

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

const INIT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 300_000;
/** 连续重启失败的最大次数（成功调用后清零）。 */
const MAX_RESTARTS = 5;
/** 指数退避的基准与上限。 */
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class McpClient {
  private cfg: McpServerConfig;
  private transport: McpTransport;
  private tools: Tool[] = [];
  /** 本轮连续失败的重启次数（一次成功调用后清零）。 */
  private restarts = 0;
  /** 上次重启失败原因，用于上报。 */
  private lastError = '';

  constructor(cfg: McpServerConfig) {
    this.cfg = cfg;
    const type = cfg.type ?? 'stdio';
    this.transport =
      type === 'http' ? new HttpTransport(cfg) : new StdioTransport(cfg);
  }

  get name(): string {
    return this.cfg.name;
  }

  async start(): Promise<void> {
    await this.initialize();
  }

  /** 启动传输 + 握手 + 拉取工具列表。 */
  private async initialize(): Promise<void> {
    await this.transport.start();
    await this.transport.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'ds-agent', version: '0.2.0' },
      },
      INIT_TIMEOUT_MS,
    );
    this.transport.notify('notifications/initialized', {});
    const list = (await this.transport.request('tools/list', {}, INIT_TIMEOUT_MS)) as {
      tools?: McpToolDef[];
    };
    this.tools = (list.tools ?? []).map((t) => this.toTool(t));
  }

  /**
   * stdio 进程意外退出后重启。采用指数退避：500ms → 1s → 2s → … 封顶 30s，
   * 连续失败 MAX_RESTARTS 次后放弃（本次调用返回错误，下次调用时重新计数）。
   * http 传输无持久连接，不需要重启。
   */
  private async maybeRestart(): Promise<boolean> {
    if (this.transport instanceof HttpTransport) return false;
    if (this.restarts >= MAX_RESTARTS) return false;
    const delay = Math.min(BASE_DELAY_MS * 2 ** this.restarts, MAX_DELAY_MS);
    this.restarts += 1;
    await sleep(delay);
    try {
      await this.transport.stop();
      await this.initialize();
      this.lastError = '';
      return true;
    } catch (err) {
      this.lastError = (err as Error).message;
      return false;
    }
  }

  /** 调用前确认传输存活；已死则先按退避策略重启。 */
  private async ensureAlive(): Promise<boolean> {
    if (this.transport.isAlive()) return true;
    return this.maybeRestart();
  }

  private toTool(t: McpToolDef): Tool {
    return {
      name: t.name,
      description: t.description ?? '',
      parameters: t.inputSchema ?? { type: 'object', properties: {} },
      execute: async (args) => {
        try {
          if (!(await this.ensureAlive())) {
            return `MCP 工具 ${t.name} 调用失败: 服务不可用${
              this.lastError ? `（${this.lastError}）` : `（已重试 ${this.restarts} 次）`
            }`;
          }
          const out = await this.callTool(t.name, args);
          this.restarts = 0; // 成功一次即重置退避计数
          return out;
        } catch (err) {
          // 进程在调用中途死亡 → 退避重连后再试一次
          if (!this.transport.isAlive() && (await this.maybeRestart())) {
            try {
              const out = await this.callTool(t.name, args);
              this.restarts = 0;
              return out;
            } catch (err2) {
              return `MCP 工具 ${t.name} 调用失败: ${(err2 as Error).message}`;
            }
          }
          return `MCP 工具 ${t.name} 调用失败: ${(err as Error).message}`;
        }
      },
    };
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = (await this.transport.request(
      'tools/call',
      { name, arguments: args },
      CALL_TIMEOUT_MS,
    )) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    if (res.isError) {
      return `[MCP 工具返回错误] ${JSON.stringify(res.content ?? res)}`;
    }
    const text = (res.content ?? [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
    return stringifyResult(text || JSON.stringify(res.content ?? res));
  }

  getTools(): Tool[] {
    return this.tools;
  }

  async stop(): Promise<void> {
    await this.transport.stop();
  }
}
