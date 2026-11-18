// 工具统一接口：每个工具输出 JSON Schema 定义，并实现 execute。
import type { ToolDef } from '../llm/types.js';

export interface ToolContext {
  cwd: string;
  /** 向用户回显一条提示（例如“正在运行: xxx”）。 */
  note?: (text: string) => void;
  /** 工具执行过程中的增量输出（如 bash 的 stdout 流）。供终端实时回显。 */
  onOutput?: (chunk: string) => void;
  /** 需要用户确认时调用（如危险命令）。返回 false 表示用户拒绝。 */
  confirm?: (question: string) => Promise<boolean>;
  /** 为 true 时跳过危险命令确认（/auto 模式）。 */
  autoApprove?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export function toToolDef(tool: Tool): ToolDef {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

/** 把任意执行结果转成安全的字符串（截断超长输出）。 */
export function stringifyResult(value: unknown, maxLen = 30000): string {
  const text =
    typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text.length > maxLen) {
    return text.slice(0, maxLen) + `\n...[截断，共 ${text.length} 字符]`;
  }
  return text;
}
