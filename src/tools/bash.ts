import { spawn } from 'node:child_process';
import { stringifyResult, type Tool, type ToolContext } from './types.js';
import { runSandboxed, sandboxAvailable, validateWritable } from './sandbox.js';

const DEFAULT_TIMEOUT_MS = 120_000;

// 危险命令模式：命中后需用户确认（除非 autoApprove）。
// 采用整行正则，尽量少误伤日常命令。
const DANGEROUS_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)*(\/[^ ]*|\*|\$|\~|\.)/, why: '递归/强制删除' },
  { re: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/, why: '带 -r/-f 的删除' },
  { re: /\b(git\s+push|git\s+push\s+-f|git\s+reset\s+--hard|git\s+clean\s+-)/, why: 'git 破坏性操作' },
  { re: /\b(mkfs|fdisk|dd\s+if=.*of=)/, why: '磁盘级写入/格式化' },
  { re: /\b(shutdown|reboot|poweroff|halt)\b/, why: '关机/重启' },
  { re: /\b(chmod\s+-R\s+777|chmod\s+777\s+\/|chown\s+-R\s+\/)/, why: '权限大范围变更' },
  { re: /\bcurl[^\n]*\|\s*(ba)?sh\b/, why: '远程脚本直接执行' },
  { re: /\bwget[^\n]*\|\s*(ba)?sh\b/, why: '远程脚本直接执行' },
  { re: /\bmv\s+[^\n]*\/(bin|etc|usr|lib|boot)\//, why: '移动系统目录文件' },
  { re: /\b(sudo\s+)?rm\s/, why: '删除文件' },
  { re: /\b:\(\)\s*\{[^}]*\}\s*;/, why: 'fork 炸弹' },
  { re: />\s*\/dev\/sd[a-z]/, why: '直接写磁盘设备' },
];

export function detectDangerous(command: string): string | null {
  const cmd = command.replace(/^sudo\s+/, '').trim();
  if (!cmd) return null;
  for (const { re, why } of DANGEROUS_PATTERNS) {
    if (re.test(cmd)) return why;
  }
  return null;
}

interface ShellResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 非沙箱执行，stdout 逐块回显给 onOutput。 */
function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  onOutput?: (chunk: string) => void,
): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', command], {
      cwd,
      env: process.env,
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`命令超时（${timeoutMs}ms）：${command.slice(0, 200)}`));
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      onOutput?.(s);
    });
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export interface BashToolOptions {
  /** 是否拦截危险命令并确认（默认 true）。 */
  confirmDangerous?: boolean;
}

export function makeBashTool(opts: BashToolOptions = {}): Tool {
  const confirmDangerous = opts.confirmDangerous ?? true;

  return {
    name: 'bash',
    description:
      '在 bash shell 中执行一条命令并返回 stdout/stderr 与退出码。用于运行测试、构建、git、查找文件等。避免交互式命令（如会阻塞等待输入的）。可用 sandbox:true 在 bwrap 只读根沙箱里运行（无网络、根只读、仅工作目录与 /tmp 可写），用于安全执行不可信命令。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 bash 命令' },
        timeout: {
          type: 'number',
          description: `超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}`,
        },
        sandbox: {
          type: 'boolean',
          description: '为 true 时在 bwrap 沙箱内执行（根只读、无网络）',
        },
        writable: {
          type: 'array',
          items: { type: 'string' },
          description:
            '沙箱内额外可写的路径（文件或目录，绝对路径或相对 cwd）。不填则只有工作目录与 /tmp 可写。仅 sandbox:true 时生效。',
        },
        network: {
          type: 'boolean',
          description: '沙箱内是否保留网络（默认 false，即断网）。仅 sandbox:true 时生效。',
        },
      },
      required: ['command'],
    },
    async execute(args, ctx) {
      const command = String(args.command ?? '');
      if (!command.trim()) return '空命令';
      const timeout = Math.min(
        Number(args.timeout) || DEFAULT_TIMEOUT_MS,
        600_000,
      );
      const sandbox = args.sandbox === true;

      const danger = detectDangerous(command);
      if (danger && confirmDangerous && !ctx.autoApprove) {
        const ok = ctx.confirm
          ? await ctx.confirm(
              `⚠ 检测到危险命令（${danger}）：\n    ${command.slice(0, 200)}\n是否执行？`,
            )
          : false;
        if (!ok) return '用户拒绝执行该命令。';
        ctx.note?.(`已确认执行危险命令`);
      }

      if (sandbox && !sandboxAvailable()) {
        return '沙箱不可用（未安装 bwrap），请改用非沙箱执行或安装 bubblewrap。';
      }

      // 沙箱内的额外可写路径（路径级白名单，逐个 bind，不整目录放开）
      let sandboxOpts = { network: args.network === true, writable: [] as string[] };
      if (sandbox) {
        const requested = Array.isArray(args.writable)
          ? args.writable.map((p) => String(p))
          : [];
        if (requested.length) {
          const { ok, rejected } = validateWritable(requested, ctx.cwd);
          if (rejected.length) {
            return `沙箱可写路径被拒绝（不存在或属于系统目录）：${rejected.join(', ')}`;
          }
          // 系统关键目录不允许额外放开；这些路径已在沙箱内可写
          sandboxOpts = { ...sandboxOpts, writable: ok };
        }
      }

      ctx.note?.(
        `执行: ${command.slice(0, 120)}${sandbox ? ' [沙箱]' : ''}`,
      );
      try {
        const { code, stdout, stderr } = sandbox
          ? await runSandboxed(command, ctx.cwd, sandboxOpts, timeout, ctx.onOutput)
          : await runShell(command, ctx.cwd, timeout, ctx.onOutput);
        const parts: string[] = [];
        if (stdout) parts.push(stdout.trimEnd());
        if (stderr) parts.push(`[stderr]\n${stderr.trimEnd()}`);
        parts.push(`[exit code: ${code}]`);
        return stringifyResult(parts.join('\n'));
      } catch (err) {
        return `命令执行失败: ${(err as Error).message}`;
      }
    },
  };
}
