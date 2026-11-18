// MCP 传输层抽象：stdio 与 streamable HTTP 两种实现，统一 request/notify 接口。
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { McpServerConfig } from '../config.js';

export interface McpTransport {
  start(): Promise<void>;
  /** 发送带 id 的 JSON-RPC 请求并等待结果。 */
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
  /** 发送无 id 的通知（不等待响应）。 */
  notify(method: string, params: unknown): void;
  /** 传输是否仍存活（stdio 进程未退出；http 恒为 true）。 */
  isAlive(): boolean;
  stop(): Promise<void>;
}

interface JsonRpcMessage {
  id?: number;
  result?: unknown;
  error?: unknown;
}

// ---------------------------------------------------------------- stdio 传输
export class StdioTransport implements McpTransport {
  private cfg: McpServerConfig;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 0;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private buffer = '';
  private dead = false;

  constructor(cfg: McpServerConfig) {
    this.cfg = cfg;
  }

  async start(): Promise<void> {
    this.dead = false;
    this.buffer = ''; // 重启时丢弃上一次会话的半包残留
    const proc = spawn(this.cfg.command ?? '', this.cfg.args ?? [], {
      env: { ...process.env, ...(this.cfg.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    proc.stdout.on('data', (d) => this.onData(d.toString()));
    proc.stderr.on('data', () => {
      /* stderr 静默，避免污染终端；错误经 exit/error 通道上报 */
    });
    proc.on('error', (err) => {
      this.dead = true;
      this.failAll(err);
    });
    proc.on('exit', (code) => {
      this.dead = true;
      if (code !== 0 && code !== null) {
        this.failAll(new Error(`stdio server 退出，code=${code}`));
      }
    });
  }

  isAlive(): boolean {
    return !this.dead;
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue;
      }
      if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
      // 忽略 server→client 的 request/notification
    }
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin.writable) {
        reject(new Error('stdio server 未启动'));
        return;
      }
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP ${method} 超时（${timeoutMs}ms）`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
      );
    });
  }

  notify(method: string, params: unknown): void {
    this.proc?.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n',
    );
  }

  async stop(): Promise<void> {
    this.proc?.kill();
    this.proc = null;
  }
}

// ------------------------------------------------------ streamable HTTP 传输
export class HttpTransport implements McpTransport {
  private cfg: McpServerConfig;
  private url: string;
  private sessionId: string | null = null;
  private nextId = 0;

  constructor(cfg: McpServerConfig) {
    this.cfg = cfg;
    this.url = (cfg.url ?? '').replace(/\/+$/, '');
    if (!this.url) throw new Error('http 传输需要 url 配置');
  }

  async start(): Promise<void> {
    // 无持久连接，start 为空操作；首个请求会建立 session。
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.cfg.headers ?? {}),
    };
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    return h;
  }

  async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = ++this.nextId;
    let resp: Response;
    try {
      resp = await fetch(this.url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(`MCP HTTP 请求失败: ${(err as Error).message}`);
    }
    const sid = resp.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    const ct = resp.headers.get('content-type') ?? '';
    if (ct.includes('text/event-stream')) {
      const text = await resp.text();
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (!data) continue;
        let msg: JsonRpcMessage;
        try {
          msg = JSON.parse(data) as JsonRpcMessage;
        } catch {
          continue;
        }
        if (msg.id === id) {
          if (msg.error) throw new Error(JSON.stringify(msg.error));
          return msg.result;
        }
      }
      throw new Error('SSE 响应中未找到匹配的请求 id');
    }

    const msg = (await resp.json()) as JsonRpcMessage;
    if (msg.error) throw new Error(JSON.stringify(msg.error));
    return msg.result;
  }

  notify(method: string, params: unknown): void {
    fetch(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
    }).catch(() => {
      /* 通知不等待 */
    });
  }

  isAlive(): boolean {
    return true;
  }

  async stop(): Promise<void> {
    // 无持久连接
  }
}
