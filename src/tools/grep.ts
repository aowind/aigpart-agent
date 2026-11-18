import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { stringifyResult, type Tool, type ToolContext } from './types.js';

const MAX_LINES = 300;
const TIMEOUT_MS = 30_000;

function resolve(p: string, cwd: string): string {
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p);
}

function runGrep(
  pattern: string,
  dir: string,
  glob: string | undefined,
): Promise<string> {
  return new Promise((resolve) => {
    const args = ['--line-number', '--with-filename', '--color=never'];
    if (glob) args.push('--glob', glob);
    args.push('--', pattern, '.');
    const child = execFile(
      'rg',
      args,
      { cwd: dir, maxBuffer: 10 * 1024 * 1024, timeout: TIMEOUT_MS },
      (err, stdout) => {
        // rg 退出码：0=有匹配 1=无匹配 2=出错
        if (err && (err as { code?: number }).code !== 1) {
          resolve(`grep 失败: ${err.message}`);
          return;
        }
        const lines = stdout.split('\n').filter(Boolean);
        const shown = lines.slice(0, MAX_LINES);
        let out = shown.join('\n');
        if (lines.length > MAX_LINES)
          out += `\n...[共 ${lines.length} 条，仅显示前 ${MAX_LINES} 条]`;
        resolve(out || '(无匹配)');
      },
    );
  });
}

export const grepTool: Tool = {
  name: 'grep',
  description:
    '用 ripgrep 在目录内全文检索正则表达式，返回 文件名:行号:内容。适合找符号定义、关键词出现位置。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式' },
      path: { type: 'string', description: '搜索目录（默认当前目录）' },
      glob: {
        type: 'string',
        description: '文件过滤 glob，如 "*.ts" 或 "*.{js,ts}"',
      },
    },
    required: ['pattern'],
  },
  async execute(args, ctx) {
    const pattern = String(args.pattern ?? '');
    if (!pattern) return '空 pattern';
    const dir = resolve(String(args.path ?? '.'), ctx.cwd);
    const glob = args.glob ? String(args.glob) : undefined;
    return stringifyResult(await runGrep(pattern, dir, glob));
  },
};
