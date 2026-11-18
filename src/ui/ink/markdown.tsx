// 轻量 Markdown 渲染器（零依赖，专供 Ink TUI）：
// 支持标题、段落、行内样式、代码块（含轻量语法高亮）、列表、引用、分隔线、表格。
// 流式场景下容忍未闭合的代码围栏与半行内容。
import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { C } from './theme.js';

// ---------------------------------------------------------------- 显示宽度

/** 单个码点的终端显示宽度（CJK 全角 2，组合符号 0）。 */
function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  // 组合附加符号、变体选择符
  if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // 韩文字母
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首、标点
    (cp >= 0x3041 && cp <= 0x33ff) || // 假名、CJK 兼容
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 基本区
    (cp >= 0xa000 && cp <= 0xa4cf) || // 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) || // 韩文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角形式
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展 B+
  ) {
    return 2;
  }
  return 1;
}

export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

/** 按显示宽度截断，超宽时补省略号。 */
function truncateTo(s: string, max: number): string {
  if (displayWidth(s) <= max) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

// ---------------------------------------------------------------- 块级解析

type Align = 'left' | 'center' | 'right';

export type MdBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; lang: string; lines: string[]; closed: boolean }
  | { kind: 'list'; ordered: boolean; items: Array<{ depth: number; marker: string; text: string }> }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'hr' }
  | { kind: 'table'; header: string[]; align: Align[]; rows: string[][] };

const FENCE_RE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const UL_RE = /^(\s*)([-*+])\s+(.*)$/;
const OL_RE = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  const s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return s.split('|').map((c) => c.trim());
}

function parseAlign(sep: string): Align[] {
  return splitRow(sep).map((c) => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
}

/** 把一段 Markdown 文本切成块。流式时未闭合的围栏按代码块处理。 */
export function parseBlocks(src: string): MdBlock[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 代码围栏
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2] || '';
      const body: string[] = [];
      i += 1;
      let closed = false;
      while (i < lines.length) {
        if (lines[i].trim().startsWith(marker)) {
          closed = true;
          i += 1;
          break;
        }
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ kind: 'code', lang, lines: body, closed });
      continue;
    }

    // 空行
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 分隔线
    if (HR_RE.test(line)) {
      blocks.push({ kind: 'hr' });
      i += 1;
      continue;
    }

    // 标题
    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
      i += 1;
      continue;
    }

    // 表格：表头行 + 分隔行
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const header = splitRow(line);
      const align = parseAlign(lines[i + 1]);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      blocks.push({ kind: 'table', header, align, rows });
      continue;
    }

    // 引用（连续行合并）
    if (QUOTE_RE.test(line)) {
      const q: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        q.push(QUOTE_RE.exec(lines[i])![1]);
        i += 1;
      }
      blocks.push({ kind: 'quote', lines: q });
      continue;
    }

    // 列表（同类标记连续行；深度按缩进/2 计算）
    const ul = UL_RE.exec(line);
    const ol = OL_RE.exec(line);
    if (ul || ol) {
      const ordered = Boolean(ol);
      const items: Array<{ depth: number; marker: string; text: string }> = [];
      while (i < lines.length) {
        const m = ordered ? OL_RE.exec(lines[i]) : UL_RE.exec(lines[i]);
        if (!m) break;
        const indent = m[1].replace(/\t/g, '  ').length;
        const marker = ordered ? `${m[2]}.` : '•';
        items.push({ depth: Math.min(4, Math.floor(indent / 2)), marker, text: m[3] });
        i += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    // 段落：吃到空行 / 下一个块起始
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (
        !l.trim() ||
        FENCE_RE.test(l) ||
        HEADING_RE.test(l) ||
        HR_RE.test(l) ||
        QUOTE_RE.test(l) ||
        UL_RE.test(l) ||
        OL_RE.test(l)
      ) {
        break;
      }
      para.push(l.trim());
      i += 1;
    }
    if (para.length) blocks.push({ kind: 'paragraph', text: para.join('\n') });
  }

  return blocks;
}

// ---------------------------------------------------------------- 行内样式

const INLINE_RE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~\n]+~~)|(\[[^\]\n]+\]\([^)\s]+\))/g;

/** 行内语法 → Ink 节点。不支持嵌套样式（够用且不会死循环）。 */
export function renderInline(text: string, keyBase = 'i'): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let n = 0;
  INLINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${n++}`;
    if (tok.startsWith('`')) {
      out.push(
        <Text key={key} color={C.CODE}>
          {tok.slice(1, -1)}
        </Text>,
      );
    } else if (tok.startsWith('**') || tok.startsWith('__')) {
      out.push(
        <Text key={key} bold>
          {tok.slice(2, -2)}
        </Text>,
      );
    } else if (tok.startsWith('~~')) {
      out.push(
        <Text key={key} strikethrough>
          {tok.slice(2, -2)}
        </Text>,
      );
    } else if (tok.startsWith('*') || tok.startsWith('_')) {
      out.push(
        <Text key={key} italic>
          {tok.slice(1, -1)}
        </Text>,
      );
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      if (link) {
        out.push(
          <Text key={key} color={C.LINK} underline>
            {link[1]}
          </Text>,
        );
        out.push(<Text key={`${key}-u`} color={C.DIM}>{` (${link[2]})`}</Text>);
      } else {
        out.push(tok);
      }
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** 纯文本化（用于表格单元格等需要量宽的场景）。 */
function plainInline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
}

// ---------------------------------------------------------------- 代码高亮

/** 各语言的保留字。未匹配的语言退化到「通用」集合。 */
const KEYWORDS: Record<string, string[]> = {
  ts: [
    'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
    'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'finally', 'for',
    'from', 'function', 'get', 'if', 'implements', 'import', 'in', 'infer', 'instanceof',
    'interface', 'is', 'keyof', 'let', 'namespace', 'new', 'of', 'private', 'protected', 'public',
    'readonly', 'return', 'satisfies', 'static', 'super', 'switch', 'this', 'throw', 'try',
    'type', 'typeof', 'var', 'void', 'while', 'yield',
  ],
  py: [
    'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif',
    'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda',
    'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
  ],
  sh: [
    'case', 'do', 'done', 'elif', 'else', 'esac', 'export', 'fi', 'for', 'function', 'if', 'in',
    'local', 'readonly', 'return', 'then', 'until', 'while', 'source', 'alias', 'unset',
  ],
  rust: [
    'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum', 'extern',
    'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref',
    'return', 'self', 'Self', 'static', 'struct', 'super', 'trait', 'type', 'unsafe', 'use',
    'where', 'while',
  ],
  go: [
    'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough',
    'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range',
    'return', 'select', 'struct', 'switch', 'type', 'var',
  ],
  js: [
    'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete',
    'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'let',
    'new', 'of', 'return', 'static', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var',
    'while', 'yield',
  ],
};

/** 内置类型 / 常量（用另一种颜色，和普通标识符区分）。 */
const BUILTINS: Record<string, string[]> = {
  ts: [
    'string', 'number', 'boolean', 'any', 'unknown', 'never', 'object', 'symbol', 'bigint',
    'true', 'false', 'null', 'undefined', 'Promise', 'Array', 'Map', 'Set', 'JSON', 'Math',
    'console', 'process', 'Date', 'RegExp', 'Error', 'Record', 'Partial', 'Readonly', 'Omit',
    'Pick', 'require', '__dirname',
  ],
  py: ['True', 'False', 'None', 'self', 'cls', 'print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple', 'open', 'super'],
  sh: ['true', 'false', 'echo', 'cd', 'ls', 'cat', 'grep', 'sed', 'awk', 'curl', 'git', 'npm', 'node', 'sudo', 'export', 'read'],
  rust: ['Some', 'None', 'Ok', 'Err', 'true', 'false', 'String', 'Vec', 'Option', 'Result', 'Box', 'println'],
  go: ['true', 'false', 'nil', 'string', 'int', 'int64', 'float64', 'bool', 'byte', 'rune', 'error', 'make', 'len', 'append', 'fmt', 'Println'],
  js: ['true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'console', 'window', 'document', 'Math', 'JSON', 'Promise', 'Array', 'Object', 'String', 'Number'],
};

/** 语言别名归一化。 */
function normalizeLang(lang: string): keyof typeof KEYWORDS | 'generic' {
  const l = lang.toLowerCase();
  if (['ts', 'tsx', 'typescript', 'js', 'jsx', 'javascript', 'node'].includes(l)) {
    return l.startsWith('ts') || l === 'typescript' ? 'ts' : 'js';
  }
  if (['py', 'python', 'python3'].includes(l)) return 'py';
  if (['sh', 'bash', 'zsh', 'shell', 'console', 'yaml', 'yml', 'toml', 'ini', 'conf'].includes(l)) return 'sh';
  if (['rs', 'rust'].includes(l)) return 'rust';
  if (['go', 'golang'].includes(l)) return 'go';
  return 'generic';
}

const HASH_COMMENT = new Set(['py', 'sh', 'generic']);
const kwCache = new Map<string, Set<string>>();
const biCache = new Map<string, Set<string>>();

function setsFor(lang: keyof typeof KEYWORDS | 'generic'): { kw: Set<string>; bi: Set<string> } {
  if (!kwCache.has(lang)) {
    kwCache.set(lang, new Set(KEYWORDS[lang] ?? []));
    biCache.set(lang, new Set(BUILTINS[lang] ?? []));
  }
  return { kw: kwCache.get(lang)!, bi: biCache.get(lang)! };
}

/**
 * 单行高亮。按「注释 → 字符串 → 数字 → 标识符」优先级切词，
 * 标识符再按保留字 / 内置类型 / 函数调用 / 普通文本分类上色。
 */
function highlightLine(line: string, lang: string): React.ReactNode[] {
  const norm = normalizeLang(lang);
  const { kw, bi } = setsFor(norm);
  const commentPat = HASH_COMMENT.has(norm) ? '#.*$' : '\\/\\/.*$|\\/\\*[\\s\\S]*?\\*\\/';

  const tokenRe = new RegExp(
    [
      `(${commentPat})`, // 1 注释
      // 2 字符串（单/双/反引号，含转义）
      '("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)',
      '\\b(0[xX][0-9a-fA-F]+|0[bB][01]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b', // 3 数字
      '([A-Za-z_$][\\w$]*)', // 4 标识符
    ].join('|'),
    'g',
  );

  const out: React.ReactNode[] = [];
  let last = 0;
  let n = 0;
  let m: RegExpExecArray | null;

  while ((m = tokenRe.exec(line)) !== null) {
    if (m.index > last) out.push(gray(line.slice(last, m.index), n++));
    const key = `hl-${n++}`;

    if (m[1] !== undefined) {
      // 注释：暗灰斜体，整段吞掉
      out.push(
        <Text key={key} color={C.COMMENT} italic>
          {m[1]}
        </Text>,
      );
      last = line.length; // 注释之后（Python/Shell 语义）不再着色
      break;
    }
    if (m[2] !== undefined) {
      out.push(
        <Text key={key} color={C.STRING}>
          {m[2]}
        </Text>,
      );
    } else if (m[3] !== undefined) {
      out.push(
        <Text key={key} color={C.NUMBER}>
          {m[3]}
        </Text>,
      );
    } else {
      const word = m[4];
      // 函数调用：标识符后紧跟 '('
      const after = line.slice(m.index + word.length);
      const isCall = /^\s*\(/.test(after);
      // 类型名：首字母大写的驼峰（TS/Go/Rust 常见）
      const isTypeName = /^[A-Z][A-Za-z0-9]*$/.test(word);

      if (kw.has(word)) {
        out.push(
          <Text key={key} color={C.KEYWORD} bold>
            {word}
          </Text>,
        );
      } else if (bi.has(word)) {
        out.push(
          <Text key={key} color={C.BUILTIN}>
            {word}
          </Text>,
        );
      } else if (isCall) {
        out.push(
          <Text key={key} color={C.FUNC}>
            {word}
          </Text>,
        );
      } else if (isTypeName) {
        out.push(
          <Text key={key} color={C.TYPE}>
            {word}
          </Text>,
        );
      } else {
        out.push(<Text key={key} color={C.CODE}>{word}</Text>);
      }
    }
    last = m.index + m[0].length;
    if (m[0].length === 0) tokenRe.lastIndex += 1; // 防零宽匹配死循环
  }
  if (last < line.length) out.push(gray(line.slice(last), n));
  return out;
}

/** 非关键字符（空白、运算符、标点）用正文色的暗一档。 */
function gray(s: string, n: number): React.ReactNode {
  if (!s) return null;
  // 纯空白不包 Text，减少节点数
  if (!s.trim()) return s;
  return (
    <Text key={`g-${n}`} color={C.OP}>
      {s}
    </Text>
  );
}

// ---------------------------------------------------------------- 渲染

export interface MarkdownProps {
  text: string;
  /** 可用宽度（字符列数）；缺省读取终端宽度。 */
  width?: number;
  /** 单条消息渲染上限，超出截断。 */
  maxChars?: number;
}

export function Markdown({ text, width, maxChars = 40_000 }: MarkdownProps) {
  const { stdout } = useStdout();
  const cols = width ?? stdout?.columns ?? 80;

  const body =
    text.length > maxChars
      ? text.slice(0, maxChars) + `\n\n…（内容过长，已截断 ${text.length - maxChars} 字符）`
      : text;

  const blocks = parseBlocks(body);

  return (
    <Box flexDirection="column">
      {blocks.map((b, idx) => (
        <Block key={`b${idx}`} block={b} index={idx} cols={cols} />
      ))}
    </Box>
  );
}

function Block({ block, index, cols }: { block: MdBlock; index: number; cols: number }) {
  switch (block.kind) {
    case 'heading': {
      const color = block.level <= 2 ? C.ACCENT : block.level === 3 ? C.PLAN : C.TEXT;
      return (
        <Box marginTop={index === 0 ? 0 : 1}>
          <Text color={color} bold>
            {renderInline(block.text, `h${index}`)}
          </Text>
        </Box>
      );
    }

    case 'paragraph':
      return (
        <Box marginTop={index === 0 ? 0 : 1}>
          <Text color={C.TEXT}>{renderInline(block.text, `p${index}`)}</Text>
        </Box>
      );

    case 'code': {
      const label = block.lang || 'text';
      // 行数多时加行号，便于按行引用
      const showNo = block.lines.length >= 4;
      const noW = String(block.lines.length).length;
      const innerW = Math.min(
        Math.max(
          displayWidth(label) + 6,
          ...block.lines.map((l) => displayWidth(l) + (showNo ? noW + 3 : 2)),
          10,
        ),
        Math.max(cols - 4, 10),
      );
      return (
        <Box marginTop={1} flexDirection="column">
          {/* 顶部边框 + 语言标签 */}
          <Text>
            <Text color={C.GUTTER}>{'╭─ '}</Text>
            <Text color={C.BASH} bold>
              {label}
            </Text>
            <Text color={C.GUTTER}>{' ' + '─'.repeat(Math.max(2, innerW - displayWidth(label) - 3))}</Text>
            {!block.closed ? <Text color={C.WARNING}> 输出中…</Text> : null}
          </Text>
          <Box flexDirection="column">
            {block.lines.length === 0 ? (
              <Text color={C.GUTTER}>{'│'}</Text>
            ) : (
              block.lines.map((l, i) => (
                <Text key={`c${i}`}>
                  <Text color={C.GUTTER}>{'│ '}</Text>
                  {showNo ? (
                    <Text color={C.GUTTER}>{String(i + 1).padStart(noW, ' ') + ' '}</Text>
                  ) : null}
                  {highlightLine(l, label)}
                </Text>
              ))
            )}
          </Box>
          <Text color={C.GUTTER}>{'╰' + '─'.repeat(innerW)}</Text>
        </Box>
      );
    }

    case 'list':
      return (
        <Box marginTop={index === 0 ? 0 : 1} flexDirection="column">
          {block.items.map((it, i) => (
            <Box key={`li${i}`} paddingLeft={it.depth * 2}>
              <Text color={C.ACCENT}>{it.marker} </Text>
              <Text color={C.TEXT}>{renderInline(it.text, `li${index}-${i}`)}</Text>
            </Box>
          ))}
        </Box>
      );

    case 'quote':
      return (
        <Box marginTop={index === 0 ? 0 : 1} flexDirection="column" paddingLeft={1}>
          {block.lines.map((l, i) => (
            <Box key={`q${i}`}>
              <Text color={C.SUBTLE}>{'▏ '}</Text>
              <Text color={C.DIM}>{renderInline(l, `q${index}-${i}`)}</Text>
            </Box>
          ))}
        </Box>
      );

    case 'hr':
      return (
        <Box marginTop={1}>
          <Text color={C.SUBTLE}>{'─'.repeat(Math.min(cols, 60))}</Text>
        </Box>
      );

    case 'table':
      return <Table block={block} cols={cols} index={index} />;
  }
}

function Table({
  block,
  cols,
  index,
}: {
  block: Extract<MdBlock, { kind: 'table' }>;
  cols: number;
  index: number;
}) {
  const colCount = Math.max(block.header.length, ...block.rows.map((r) => r.length), 1);
  // 每列宽度：取该列所有单元格纯文本显示宽度的最大值，限制在 [3, 40]
  const widths: number[] = [];
  for (let c = 0; c < colCount; c++) {
    let w = displayWidth(plainInline(block.header[c] ?? ''));
    for (const row of block.rows) w = Math.max(w, displayWidth(plainInline(row[c] ?? '')));
    widths.push(Math.min(Math.max(w, 3), 40));
  }
  // 总宽超出终端时按比例压缩
  const sepW = 3 * (colCount - 1);
  const total = widths.reduce((a, b) => a + b, 0) + sepW;
  const budget = Math.max(cols - 2, 20);
  if (total > budget) {
    const scale = (budget - sepW) / widths.reduce((a, b) => a + b, 0);
    for (let c = 0; c < colCount; c++) widths[c] = Math.max(3, Math.floor(widths[c] * scale));
  }

  const cell = (raw: string | undefined, c: number): string => {
    const t = truncateTo(plainInline(raw ?? ''), widths[c]);
    const w = displayWidth(t);
    const pad = Math.max(0, widths[c] - w);
    switch (block.align[c]) {
      case 'right':
        return ' '.repeat(pad) + t;
      case 'center': {
        const left = Math.floor(pad / 2);
        return ' '.repeat(left) + t + ' '.repeat(pad - left);
      }
      default:
        return t + ' '.repeat(pad);
    }
  };

  // 行宽不齐时补齐到列数，否则列会错位
  const line = (cells: string[]) =>
    Array.from({ length: colCount }, (_, c) => cell(cells[c], c)).join(' │ ');

  return (
    <Box marginTop={index === 0 ? 0 : 1} flexDirection="column">
      <Text color={C.TEXT} bold>
        {line(block.header)}
      </Text>
      <Text color={C.SUBTLE}>{widths.map((w) => '─'.repeat(w)).join('─┼─')}</Text>
      {block.rows.map((row, r) => (
        <Text key={`tr${r}`} color={C.TEXT}>
          {line(row)}
        </Text>
      ))}
    </Box>
  );
}
