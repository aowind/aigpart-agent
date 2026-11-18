// 展开用户输入中的 @路径 引用为多模态内容。
// 只处理图片路径：视觉模型走 image part，非视觉模型转文本提示。
// 其余 @（如邮箱、普通文件引用）保持原样，避免误伤。
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ContentPart, MessageContent } from '../llm/types.js';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// 匹配「行首或空白后的 @非空白」，且该 token 以图片扩展名结尾。
const AT_REF_RE = /(^|[\s(（])@([^\s@()（）,，;；]+)/g;

function resolveAt(p: string, cwd: string): string {
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p);
}

function tryImage(p: string): { dataUrl: string } | null {
  const ext = path.extname(p).toLowerCase();
  const mime = MIME[ext];
  if (!mime) return null;
  try {
    const stat = fs.statSync(p);
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null;
    const buf = fs.readFileSync(p);
    return { dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
  } catch {
    return null;
  }
}

export function expandAtRefs(
  text: string,
  cwd: string,
  vision: boolean,
): MessageContent {
  const matches: Array<{
    start: number;
    end: number;
    prefix: string;
    ref: string;
  }> = [];
  AT_REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AT_REF_RE.exec(text)) !== null) {
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      prefix: m[1],
      ref: m[2],
    });
  }

  if (!matches.length) return text;

  const parts: ContentPart[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) {
      parts.push({ type: 'text', text: text.slice(cursor, match.start) });
    }
    const abs = resolveAt(match.ref, cwd);
    const img = tryImage(abs);
    if (img) {
      if (vision) {
        parts.push({
          type: 'text',
          text: `\n[用户引用的图片 ${match.ref}]\n`,
        });
        parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
      } else {
        parts.push({
          type: 'text',
          text: `\n[用户引用了图片 ${match.ref}，但当前模型不支持视觉，无法识别其内容]\n`,
        });
      }
    } else {
      // 非图片或文件不存在：保留原 token
      parts.push({ type: 'text', text: match.prefix + '@' + match.ref });
    }
    cursor = match.end;
  }
  if (cursor < text.length) {
    parts.push({ type: 'text', text: text.slice(cursor) });
  }
  return parts;
}
