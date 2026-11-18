import { stringifyResult, type Tool } from './types.js';

export const webFetchTool: Tool = {
  name: 'webfetch',
  description:
    '抓取一个 URL，把页面转成纯文本摘要后返回。用于查文档、API 说明。仅支持公开 HTTP(S) 页面，不适合需要登录的内容。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '完整 URL' },
    },
    required: ['url'],
  },
  async execute(args) {
    const url = String(args.url ?? '');
    if (!/^https?:\/\//i.test(url)) return '无效 URL（需 http/https）';
    try {
      const resp = await fetch(url, {
        headers: { 'user-agent': 'ds-agent/0.1 (+webfetch)' },
        redirect: 'follow',
      });
      if (!resp.ok) return `HTTP ${resp.status} ${resp.statusText}`;
      const html = await resp.text();
      const text = stripHtml(html);
      return stringifyResult(text, 20000);
    } catch (err) {
      return `抓取失败: ${(err as Error).message}`;
    }
  },
};

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
