import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { stringifyResult, type Tool, type ToolContext } from './types.js';

const MAX_READ_BYTES = 200_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

function resolve(p: string, cwd: string): string {
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p);
}

async function listDir(dir: string): Promise<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const lines = entries.map((e) => {
    const suffix = e.isDirectory() ? '/' : e.isSymbolicLink() ? '@' : '';
    return e.name + suffix;
  });
  lines.sort();
  return lines.join('\n');
}

async function readImageAsBase64(p: string): Promise<string | null> {
  const ext = path.extname(p).toLowerCase();
  const mime = MIME[ext];
  if (!mime) return null;
  const stat = await fs.stat(p);
  if (stat.size > MAX_IMAGE_BYTES) return null;
  const buf = await fs.readFile(p);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

export const readTool: Tool = {
  name: 'read',
  description:
    '读取文件内容（文本或图片）。纯文本以带行号形式返回；图片以 base64 data URL 返回（供视觉模型识别）。超过大小限制时给出行数范围，可配合 offset/limit 分段读取。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（绝对或相对）' },
      offset: { type: 'number', description: '从第几行开始（1 起）' },
      limit: { type: 'number', description: '读取多少行' },
    },
    required: ['path'],
  },
  async execute(args, ctx) {
    const p = resolve(String(args.path ?? ''), ctx.cwd);
    try {
      const stat = await fs.stat(p);
      if (stat.isDirectory()) {
        return stringifyResult(await listDir(p));
      }
      // 图片：返回 base64 data URL，交给视觉模型
      const image = await readImageAsBase64(p);
      if (image) {
        return `[图片，已编码为 data URL，可直接交给视觉模型]\n${image}`;
      }
      if (stat.size > MAX_READ_BYTES) {
        const buf = await fs.readFile(p);
        const text = buf.toString('utf8');
        const lines = text.split('\n');
        return stringifyResult(
          `[文件较大：${stat.size} 字节，共 ${lines.length} 行。请用 offset/limit 分段读取]\n` +
            lines.slice(0, 5).map((l, i) => `${i + 1}\t${l}`).join('\n'),
        );
      }
      const text = await fs.readFile(p, 'utf8');
      let lines = text.split('\n');
      const offset = Math.max(1, Number(args.offset) || 1);
      const limit = Number(args.limit) || lines.length;
      const start = offset - 1;
      lines = lines.slice(start, start + limit);
      return stringifyResult(
        lines.map((l, i) => `${start + i + 1}\t${l}`).join('\n'),
      );
    } catch (err) {
      return `读取失败: ${(err as Error).message}`;
    }
  },
};

export const writeTool: Tool = {
  name: 'write',
  description:
    '创建或整体覆盖一个文件。父目录不存在时自动创建。适合新建文件或完整替换；局部修改请用 edit。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      content: { type: 'string', description: '要写入的完整内容' },
    },
    required: ['path', 'content'],
  },
  async execute(args, ctx) {
    const p = resolve(String(args.path ?? ''), ctx.cwd);
    const content = String(args.content ?? '');
    try {
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, content, 'utf8');
      return `已写入 ${p}（${content.length} 字符）`;
    } catch (err) {
      return `写入失败: ${(err as Error).message}`;
    }
  },
};

export const editTool: Tool = {
  name: 'edit',
  description:
    '对文件做精确字符串替换：将 old_string 替换为 new_string。old_string 必须与文件内容完全一致（含缩进）且唯一，否则失败。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      old_string: { type: 'string', description: '要被替换的原文（精确匹配）' },
      new_string: { type: 'string', description: '替换后的新文本' },
      replace_all: {
        type: 'boolean',
        description: '为 true 时替换所有匹配（默认 false，要求唯一匹配）',
      },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(args, ctx) {
    const p = resolve(String(args.path ?? ''), ctx.cwd);
    const oldStr = String(args.old_string ?? '');
    const newStr = String(args.new_string ?? '');
    try {
      const text = await fs.readFile(p, 'utf8');
      const replaceAll = args.replace_all === true;
      const count = text.split(oldStr).length - 1;
      if (count === 0) return '替换失败: 未找到 old_string';
      if (!replaceAll && count > 1) {
        return `替换失败: old_string 出现 ${count} 次，请提供更长的上下文使其唯一，或设 replace_all=true`;
      }
      const next = replaceAll ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr);
      await fs.writeFile(p, next, 'utf8');
      return `已替换 ${replaceAll ? count : 1} 处（${p}）`;
    } catch (err) {
      return `替换失败: ${(err as Error).message}`;
    }
  },
};

export const lsTool: Tool = {
  name: 'ls',
  description: '列出目录内容，等价于带文件类型标记的 ls。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目录路径（默认当前目录）' },
    },
  },
  async execute(args, ctx) {
    const p = resolve(String(args.path ?? '.'), ctx.cwd);
    try {
      return stringifyResult(await listDir(p));
    } catch (err) {
      return `列目录失败: ${(err as Error).message}`;
    }
  },
};
