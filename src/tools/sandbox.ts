// 沙箱执行：用 bubblewrap (bwrap) 在只读根 + 可写 workspace 的隔离环境里跑命令。
// 默认断网、清空环境、unshare 所有命名空间。bwrap 不可用则回退报错。
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';

export interface SandboxOptions {
  /** 是否允许网络（默认 false，断网更安全）。 */
  network?: boolean;
  /**
   * 额外可写路径（文件或目录，绝对路径）。
   * 只有列在这里的路径才会从只读根里「挖」出来变成可写，其余保持只读。
   */
  writable?: string[];
}

export interface ShellResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const BWRAP = '/usr/bin/bwrap';

export function sandboxAvailable(): boolean {
  return existsSync(BWRAP);
}

/** 把用户给的路径规范化成绝对路径（相对路径按 cwd 解析）。 */
function resolvePath(p: string, cwd: string): string {
  return path.resolve(cwd, p);
}

/**
 * 校验可写白名单：必须存在，且不允许是根、也不允许是系统关键目录，
 * 避免一次 `sandbox:true` 就把整个 /etc 挂成可写。
 */
export function validateWritable(
  paths: string[],
  cwd: string,
): { ok: string[]; rejected: string[] } {
  const ok: string[] = [];
  const rejected: string[] = [];
  const forbidden = ['/', '/boot', '/dev', '/proc', '/sys', '/usr', '/bin', '/sbin', '/lib', '/etc', '/root'];
  for (const raw of paths) {
    const p = resolvePath(raw, cwd);
    if (forbidden.includes(p)) {
      rejected.push(raw);
      continue;
    }
    try {
      statSync(p); // 不存在会抛错
    } catch {
      rejected.push(raw);
      continue;
    }
    ok.push(p);
  }
  return { ok, rejected };
}

/** 构造 bwrap 参数。 */
function buildBwrapArgs(
  command: string,
  cwd: string,
  opts: SandboxOptions,
): string[] {
  const args: string[] = [
    '--die-with-parent',
    '--new-session',
    // 只读根，让整个系统只读
    '--ro-bind', '/', '/',
    // 可写 workspace 与 /tmp
    '--bind', cwd, cwd,
    '--bind', '/tmp', '/tmp',
    // 设备与进程
    '--dev', '/dev',
    '--proc', '/proc',
    // unshare：默认全隔离；若允许网络则去掉 --unshare-net
  ];
  if (!opts.network) {
    args.push('--unshare-all');
  } else {
    args.push(
      '--unshare-user',
      '--unshare-ipc',
      '--unshare-pid',
      '--unshare-uts',
      '--unshare-cgroup',
    );
  }
  // 路径级白名单：只把列出的路径 bind 成可写（单个文件也可）
  for (const w of opts.writable ?? []) {
    if (w === cwd || w === '/tmp') continue;
    args.push('--bind', w, w);
  }
  args.push('--chdir', cwd);
  // 最小化环境
  args.push('--clearenv');
  args.push('--setenv', 'PATH', '/usr/bin:/bin:/usr/local/bin');
  args.push('--setenv', 'HOME', cwd);
  args.push('--setenv', 'TMPDIR', '/tmp');
  args.push('--', 'bash', '-c', command);
  return args;
}

export function runSandboxed(
  command: string,
  cwd: string,
  opts: SandboxOptions,
  timeoutMs: number,
  onOutput?: (chunk: string) => void,
): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    const args = buildBwrapArgs(command, cwd, opts);
    const child = spawn(BWRAP, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`沙箱命令超时（${timeoutMs}ms）`));
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
