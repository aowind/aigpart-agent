import * as fs from 'node:fs';
import * as path from 'node:path';
import { stringifyResult, type Tool } from '../tools/types.js';

export interface Skill {
  name: string;
  description: string;
  dir: string;
  body: string; // SKILL.md 全文（去掉 frontmatter）
}

function parseSkill(markdown: string): { description: string; body: string } {
  let description = '';
  let body = markdown;
  // 提取 frontmatter 中的 description
  const fmMatch = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const descMatch = fm.match(/^description:\s*(.+)$/m);
    if (descMatch) description = descMatch[1].trim();
    body = markdown.slice(fmMatch[0].length);
  }
  return { description, body };
}

/**
 * 扫描 skill 目录。约定：目录下每个子目录是一个 skill，
 * 其内须有 SKILL.md（或与目录同名的 .md 文件）。
 */
export function scanSkills(dirs: string[]): Skill[] {
  const skills: Skill[] = [];
  for (const dir of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(dir, entry.name);
      const candidates = [path.join(skillDir, 'SKILL.md'), path.join(skillDir, `${entry.name}.md`)];
      const file = candidates.find((f) => fs.existsSync(f));
      if (!file) continue;
      const markdown = fs.readFileSync(file, 'utf8');
      const { description, body } = parseSkill(markdown);
      skills.push({ name: entry.name, description, dir: skillDir, body });
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** 生成注入系统提示词的 skill 概览（只列名称与描述，正文惰性加载）。 */
export function skillsOverview(skills: Skill[]): string {
  if (!skills.length) return '';
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  return `\n## 可用的 Skill（匹配任务时先用 skill 工具读取对应正文）\n${lines.join('\n')}`;
}

/** skill 读取工具（惰性加载正文，避免把全部 skill 塞进上下文）。 */
export function makeSkillTool(skills: Skill[]): Tool {
  const map = new Map(skills.map((s) => [s.name, s]));
  return {
    name: 'skill',
    description:
      '读取指定 skill 的完整说明文档。当任务匹配某个已列出的 skill 时，先调用它读取正文再动手。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'skill 名称' },
      },
      required: ['name'],
    },
    async execute(args) {
      const name = String(args.name ?? '').trim();
      const skill = map.get(name);
      if (!skill) {
        return `未知 skill：${name}。可用的：${[...map.keys()].join(', ') || '(无)'}`;
      }
      return stringifyResult(`# ${skill.name}\n\n${skill.body}`, 20000);
    },
  };
}

/** 默认 skill 搜索目录。 */
export function defaultSkillDirs(cwd: string, homeDir: string): string[] {
  return [path.join(cwd, '.ds-agent', 'skills'), path.join(homeDir, 'skills')];
}
