// Claude Code（omarchy 主题）同款配色，逐字取自 ~/.claude/themes/omarchy.json。
// 名称对应该主题里的 key，值未改动。
export const C = {
  /** claude —— 助手/提示词主色（紫）。 */
  ACCENT: '#7d82d9',
  /** text —— 正文（暖杏色）。 */
  TEXT: '#ffcead',
  /** briefLabelYou —— 用户 "❯" 与用户标签（金）。 */
  USER: '#E9BB4F',
  /** inactive —— 弱化/时间等（灰棕）。 */
  DIM: '#9b8074',
  /** subtle —— 更弱的提示。 */
  SUBTLE: '#6d7db6',
  /** success —— 成功。 */
  SUCCESS: '#92a593',
  /** error —— 错误。 */
  ERROR: '#ED5B5A',
  /** warning / autoAccept —— 警告、自动放行。 */
  WARNING: '#E9BB4F',
  /** promptBorder —— 输入框边框。 */
  PROMPT: '#7d82d9',
  /** bashBorder —— bash 工具块边框（浅金）。 */
  BASH: '#f7dc9c',
  /** planMode —— 计划模式。 */
  PLAN: '#a3bfd1',
  /** 行内代码与代码块正文。 */
  CODE: '#e0c9a6',
  /** 链接。 */
  LINK: '#7d9fd9',
  /** 代码里的字符串字面量。 */
  STRING: '#a8c99b',
  /** 代码里的数字字面量。 */
  NUMBER: '#d9a97d',
  /** 代码里的类型 / 类名。 */
  TYPE: '#7ec8d9',
  /** 代码里的函数 / 方法名。 */
  FUNC: '#e6d08a',
  /** 代码里的标点与运算符。 */
  PUNCT: '#6f7a8a',
  /** 代码里的注释。 */
  COMMENT: '#6b7280',
  /** 代码里的保留字（更亮，突出语法骨架）。 */
  KEYWORD: '#c792ea',
  /** 代码里的内置类型 / 常量。 */
  BUILTIN: '#7ec8d9',
  /** 代码里的运算符与标点。 */
  OP: '#8a93a6',
  /** 代码块行首的竖线（gutter）。 */
  GUTTER: '#3d4351',
  /** 输入区上下横线与状态栏分隔线。 */
  BORDER: '#4a4a63',
  /** 用户输入正文：比 USER 更亮，配合 bold 突出。 */
  USER_BRIGHT: '#ffe3a3',
  /** 思考/推理流：低饱和灰，避免抢正文注意力。 */
  REASONING: '#8c8c9e',
  /** 启动横幅里的品牌 logo。 */
  LOGO: '#9aa4c8',
  /** 统计块里的正文字。 */
  MUTED: '#7a7a92',
};

/** 各工具块的边框色。bash 用其专用色，其余沿用 prompt 紫。 */
export function toolBorder(name?: string): string {
  if (name === 'bash') return C.BASH;
  if (name === 'task' || name === 'compact') return C.SUBTLE;
  return C.ACCENT;
}
