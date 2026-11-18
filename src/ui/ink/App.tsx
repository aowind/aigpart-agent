import React, { useRef, useState } from 'react';
import { Box, Text, Static, useInput, useStdout } from 'ink';
import { C, toolBorder } from './theme.js';
import { Markdown } from './markdown.js';
import {
  AGENT_NAME,
  AGENT_TAGLINE,
  APP_VERSION,
  COPYRIGHT,
  LOGO_PIXELS,
} from './logo.js';
import { useUiModel, type UiModel } from './model.js';
import type { DisplayLine } from './types.js';

interface AppProps {
  model: UiModel;
  onSubmit: (text: string) => void;
  onCancel: () => void;
  onModelSet: (id: string) => void;
  onModelList: () => void;
  onPlan: () => void;
  onAuto: () => void;
  onClear: () => void;
  onToolList: () => void;
  onSessionList: () => void;
  onQuit: () => void;
}

export default function App(props: AppProps) {
  const s = useUiModel(props.model);
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const valueRef = useRef('');
  const cursorRef = useRef(0);

  valueRef.current = value;
  cursorRef.current = cursor;

  useInput((input, key) => {
    // 有待确认的问题时，只认 y / n / Esc
    if (s.confirmQuestion) {
      if (input === 'y' || input === 'Y') props.model.answerConfirm(true);
      else if (input === 'n' || input === 'N') props.model.answerConfirm(false);
      else if (key.escape) props.model.answerConfirm(false);
      return;
    }

    if (s.busy) {
      if (key.escape || (key.ctrl && input === 'c')) props.onCancel();
      return;
    }

    if (key.escape) {
      setValue('');
      setCursor(0);
      return;
    }

    // Shift+Tab：在 normal / plan 之间循环（与 Claude Code 一致）
    if (key.tab && key.shift) {
      props.onPlan();
      return;
    }

    // 回车：真实终端发 \r（Ink 记为 return），部分终端 / PTY 发 \n（Ink 记为 enter，
    // 且不在 nonAlphanumericKeys 里，会漏到「可打印字符」分支被塞进缓冲区）；
    // 粘贴多行内容时，整段文字连同末尾换行会在同一个数据块里到达。
    // 统一处理：以最后一个换行为界，之前的内容全部提交（保留内部换行），之后留在输入框。
    const combined = valueRef.current + (input ?? '');
    const lastNl = Math.max(combined.lastIndexOf('\r'), combined.lastIndexOf('\n'));
    if (key.return || lastNl >= 0) {
      const submitRaw = lastNl >= 0 ? combined.slice(0, lastNl) : combined;
      const rest = lastNl >= 0 ? combined.slice(lastNl + 1).replace(/^[\r\n]+/, '') : '';
      const text = submitRaw.trim();
      setValue(rest);
      setCursor(rest.length);
      if (text === '') return;
      if (text === '/quit' || text === '/exit' || text === '/q') {
        props.onQuit();
      } else if (text === '/help' || text === '/h' || text === '?') {
        props.model.addStatus(
          [
            '命令',
            '  /model <id>   切换模型（不带参数列出可选）',
            '  /plan         计划模式：只读调查 → 给出计划',
            '  /auto         危险命令自动放行开关',
            '  /clear        清空当前上下文',
            '  /tools        列出当前可用工具',
            '  /sessions     列出历史会话',
            '  /quit         退出',
            '',
            '快捷键',
            '  Enter         发送消息',
            '  Esc           清空输入；运行中为中断任务',
            '  Shift+Tab     切换 plan 模式',
            '  ← / →         移动光标',
            '  Backspace     删除字符',
            '  Ctrl+C        退出',
          ].join('\n'),
          'info',
        );
      } else if (text === '/model') {
        props.onModelList();
      } else if (text.startsWith('/model ')) {
        props.onModelSet(text.slice(7).trim());
      } else if (text === '/plan') {
        props.onPlan();
      } else if (text === '/auto') {
        props.onAuto();
      } else if (text === '/clear') {
        props.onClear();
      } else if (text === '/tools') {
        props.onToolList();
      } else if (text === '/sessions' || text === '/ls') {
        props.onSessionList();
      } else if (text.startsWith('/')) {
        props.model.addStatus(`未知命令 ${text}，输入 /help 查看可用命令`, 'error');
      } else {
        props.onSubmit(text);
      }
      return;
    }

    // 可打印字符：一次数据事件可能是单键，也可能是整段粘贴（多字符）。
    // 过滤掉控制字符，只插入可见部分。
    if (input && !key.ctrl && !key.meta) {
      const printable = Array.from(input)
        .filter((ch) => ch.charCodeAt(0) >= 32)
        .join('');
      if (printable) {
        const cur = cursorRef.current;
        setValue((prev) => prev.slice(0, cur) + printable + prev.slice(cur));
        setCursor(cur + printable.length);
        return;
      }
    }
    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1));
    } else if (key.rightArrow) {
      setCursor((c) => Math.min(valueRef.current.length, c + 1));
    } else if (key.backspace || key.delete) {
      // 真实终端的 Backspace 发 DEL(0x7f)，Ink 把它记成 delete；而 Delete(ESC[3~) 也是 delete，
      // 两者在 useInput 的 key 对象里无法区分（input 都被置空）。Backspace 使用频率远高，
      // 故统一按退格（删光标左侧）处理。
      const cur = cursorRef.current;
      if (cur > 0) {
        setValue((prev) => prev.slice(0, cur - 1) + prev.slice(cur));
        setCursor(cur - 1);
      }
    }
  });

  const barWidth = Math.max(20, Math.min(cols, 120));

  return (
    <Box flexDirection="column">
      {/* 已封口的历史：只增不减，交给 Static 冻结 */}
      <Static items={s.completed}>
        {(line) => <LineView key={line.id} line={line} cols={cols} />}
      </Static>

      {/* 正在流式的内容：动态渲染（不能进 Static，否则被冻结） */}
      {s.active.length > 0 ? (
        <Box flexDirection="column">
          {s.active.map((line) => (
            <LineView key={line.id} line={line} cols={cols} />
          ))}
        </Box>
      ) : null}

      {/* 运行时进度与提示（紧贴输入框上方） */}
      {s.busy && !s.confirmQuestion ? <ProgressLine state={s} /> : null}

      {/* 确认框 */}
      {s.confirmQuestion ? (
        <Box marginTop={1} borderStyle="round" borderColor={C.WARNING} paddingX={1}>
          <Box flexDirection="column">
            <Text color={C.WARNING} bold>
              {s.confirmQuestion}
            </Text>
            <Text color={C.DIM}>[y/N]</Text>
          </Box>
        </Box>
      ) : null}

      {/* 底部固定区：上横线 → 输入行 → 下横线 → 状态栏 */}
      <Box flexDirection="column" marginTop={1}>
        <Text color={C.BORDER}>{'─'.repeat(barWidth)}</Text>

        <Box>
          <Text color={C.USER} bold>
            {'❯ '}
          </Text>
          <InputView value={value} cursor={cursor} width={Math.max(4, barWidth - 2)} />
        </Box>

        <Text color={C.BORDER}>{'─'.repeat(barWidth)}</Text>

        <StatusBar
          width={barWidth}
          mode={s.busy ? 'BUSY' : s.planMode ? 'PLAN' : 'DEFAULT'}
          auto={s.autoApprove}
          model={s.model}
          left={
            s.busy && !s.confirmQuestion
              ? 'Esc 中断'
              : s.planMode
                ? '只读调查 · Shift+Tab 退出'
                : 'Enter 发送 · Esc 清空 · /help 命令'
          }
        />
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------- 进度行

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** 运行时进度：spinner + 已耗时 + 步数 + 当前阶段，右侧轮播小贴士。 */
function ProgressLine({ state }: { state: ReturnType<typeof useUiModel> }) {
  const [, force] = useState(0);
  // 每 120ms 重绘一次，驱动 spinner 与计时
  React.useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 120);
    return () => clearInterval(t);
  }, []);

  const started = state.turnStartedAt ?? Date.now();
  const elapsed = Math.max(0, Date.now() - started);
  const secs = Math.floor(elapsed / 1000);
  const elapsedText = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${secs % 60}s`;
  const frame = SPINNER[Math.floor(elapsed / 120) % SPINNER.length];
  const tips = RUNNING_TIPS[Math.floor(elapsed / 6000) % RUNNING_TIPS.length];

  return (
    <Box marginTop={1} flexDirection="column">
      <Box>
        <Text color={C.ACCENT}>{`${frame} `}</Text>
        <Text color={C.SUBTLE}>{'处理中'}</Text>
        <Text color={C.DIM}>{'  ·  '}</Text>
        <Text color={C.PLAN}>{elapsedText}</Text>
        {state.step > 0 ? (
          <>
            <Text color={C.DIM}>{'  ·  第 '}</Text>
            <Text color={C.PLAN}>{String(state.step)}</Text>
            <Text color={C.DIM}>{' 步'}</Text>
          </>
        ) : null}
        {state.phase ? (
          <>
            <Text color={C.DIM}>{'  ·  '}</Text>
            <Text color={C.TEXT}>{state.phase}</Text>
          </>
        ) : null}
        {state.streamed > 0 ? (
          <>
            <Text color={C.DIM}>{'  ·  已输出 '}</Text>
            <Text color={C.SUBTLE}>{String(state.streamed)}</Text>
            <Text color={C.DIM}>{' 字'}</Text>
          </>
        ) : null}
      </Box>
      <Box>
        <Text color={C.DIM}>{`  ⎿  ${tips}`}</Text>
      </Box>
    </Box>
  );
}

const RUNNING_TIPS = [
  'Esc 可中断当前任务，已产生的输出会保留',
  '工具调用并行执行，结果按原始顺序回填',
  '上下文过长时会自动摘要压缩早期消息',
  '危险命令默认需要确认，/auto 可关闭确认',
  '用 @路径 可以在下一条消息里附上图片或文件',
  'Shift+Tab 随时切到计划模式，只读调查不动文件',
  '用 task 工具可派发子 agent 并行处理独立子任务',
];

// ---------------------------------------------------------------- 输入行

/** 输入行：超宽时围绕光标横向滚动，光标处字符反显。 */
function InputView({ value, cursor, width }: { value: string; cursor: number; width: number }) {
  if (!value) {
    return (
      <Text>
        <Text inverse>{' '}</Text>
        <Text color={C.DIM}>试试问我：帮我看看这个项目 / 修一下这个报错 / 解释这段代码</Text>
      </Text>
    );
  }

  // 光标在窗口内的位置；窗口尽量把光标放中间偏右
  const chars = Array.from(value);
  let start = 0;
  if (chars.length > width) {
    start = Math.max(0, Math.min(cursor - Math.floor(width / 2), chars.length - width));
  }
  const visible = chars.slice(start, start + width);
  const localCursor = cursor - start;

  const before = visible.slice(0, Math.max(0, localCursor)).join('');
  const cursorChar = visible[localCursor] ?? ' ';
  const after = visible.slice(localCursor + 1).join('');
  const prefix = start > 0 ? '…' : '';

  return (
    <Text>
      <Text color={C.DIM}>{prefix}</Text>
      <Text color={C.PROMPT}>{before}</Text>
      <Text inverse>{cursorChar}</Text>
      <Text color={C.PROMPT}>{after}</Text>
    </Text>
  );
}

/** 状态栏：左模式与开关，右快捷键提示。 */
function StatusBar({
  width,
  mode,
  auto,
  model,
  left,
}: {
  width: number;
  mode: 'DEFAULT' | 'PLAN' | 'BUSY';
  auto: boolean;
  model: string;
  left: string;
}) {
  const modeColor = mode === 'PLAN' ? C.PLAN : mode === 'BUSY' ? C.WARNING : C.SUCCESS;
  const modeLabel = mode === 'PLAN' ? 'plan' : mode === 'BUSY' ? 'running' : 'normal';

  return (
    <Box justifyContent="space-between" width={width}>
      <Text>
        <Text color={C.DIM}>{'  '}</Text>
        <Text color={modeColor} bold>
          {modeLabel}
        </Text>
        <Text color={C.DIM}>{' · auto '}</Text>
        <Text color={auto ? C.WARNING : C.DIM} bold={auto}>
          {auto ? 'on' : 'off'}
        </Text>
        <Text color={C.DIM}>{' · '}</Text>
        <Text color={C.SUBTLE}>{model}</Text>
      </Text>
      <Text color={C.DIM}>{left}</Text>
    </Box>
  );
}

// ---------------------------------------------------------------- 行渲染

function LineView({ line, cols }: { line: DisplayLine; cols: number }) {
  switch (line.kind) {
    // 用户输入：加粗 + 高亮色，与回复明确区分
    case 'user':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color={C.USER} bold>
              {'❯ '}
            </Text>
            <Text color={C.USER_BRIGHT} bold>
              {line.text}
            </Text>
          </Box>
        </Box>
      );

    // 思考过程：低饱和灰斜体，前缀 ✻，不抢正文注意力
    case 'reasoning':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box paddingLeft={2}>
            <Text color={C.REASONING}>{'✻ '}</Text>
            <Text color={C.REASONING}>思考中</Text>
            {line.streaming ? <Text color={C.REASONING}>…</Text> : null}
          </Box>
          <Box paddingLeft={4}>
            <Text color={C.REASONING} dimColor italic>
              {truncate(line.text, 1200)}
            </Text>
          </Box>
        </Box>
      );

    case 'assistant':
      // 与 Claude Code 一致：正文直接缩进呈现，不重复打产品名
      return (
        <Box flexDirection="column" marginTop={1} paddingLeft={2}>
          <Markdown text={line.text} width={Math.max(20, cols - 4)} />
          {line.streaming ? <Text color={C.ACCENT}>▌</Text> : null}
        </Box>
      );

    case 'tool': {
      const color = toolBorder(line.name);
      const dur =
        line.startedAt && line.endedAt ? `${((line.endedAt - line.startedAt) / 1000).toFixed(1)}s` : '';
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color={color} bold>
              {line.done ? (line.failed ? '✗ ' : '⏺ ') : '⏺ '}
            </Text>
            <Text color={color} bold>
              {line.name}
            </Text>
            {line.argsBrief ? (
              <Text color={C.SUBTLE}>{`(${truncate(line.argsBrief, Math.max(20, cols - 40))})`}</Text>
            ) : null}
            {!line.done ? (
              <Text color={C.WARNING}>{' 运行中…'}</Text>
            ) : dur ? (
              <Text color={C.DIM}>{`  ${dur}`}</Text>
            ) : null}
          </Box>
          {line.output ? (
            <Box paddingLeft={2}>
              <Text color={C.DIM}>{`⎿  ${truncate(previewOutput(line.output), 1200)}`}</Text>
            </Box>
          ) : null}
        </Box>
      );
    }

    case 'status':
      return (
        <Box marginTop={1} paddingLeft={2}>
          <Text
            color={
              line.tone === 'error' ? C.ERROR : line.tone === 'success' ? C.SUCCESS : C.SUBTLE
            }
          >
            {line.tone === 'error' ? '✗ ' : '⎿  '}
            {line.text}
          </Text>
        </Box>
      );

    case 'banner':
      return <Banner line={line} cols={cols} />;

    case 'stats':
      return <Stats line={line} />;
  }
}

/** 启动横幅：logo + 名称 + 模型/模式/目录 + 提示。 */
function Banner({
  line,
  cols,
}: {
  line: Extract<DisplayLine, { kind: 'banner' }>;
  cols: number;
}) {
  const modeLabel = line.planMode ? 'plan' : 'normal';
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        {/* 左侧 logo：按 favicon 逐像素上色的半块字符画 */}
        <Box flexDirection="column" marginRight={2}>
          {LOGO_PIXELS.map((row, i) => (
            <Text key={`lg${i}`}>
              {row.map(([ch, fg, bg], j) => (
                <Text key={`p${i}-${j}`} color={fg} backgroundColor={bg || undefined}>
                  {ch}
                </Text>
              ))}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" justifyContent="center">
          <Text>
            <Text color={C.ACCENT} bold>
              {AGENT_NAME}
            </Text>
            <Text color={C.DIM}>{`  v${APP_VERSION}`}</Text>
          </Text>
          <Text color={C.DIM}>{AGENT_TAGLINE}</Text>
          <Box marginTop={1} flexDirection="column">
            <Text>
              <Text color={C.DIM}>{'模型  '}</Text>
              <Text color={C.SUBTLE}>{line.model}</Text>
            </Text>
            <Text>
              <Text color={C.DIM}>{'模式  '}</Text>
              <Text color={line.planMode ? C.PLAN : C.SUCCESS} bold>
                {modeLabel}
              </Text>
              <Text color={C.DIM}>{'   auto '}</Text>
              <Text color={line.autoApprove ? C.WARNING : C.DIM} bold={line.autoApprove}>
                {line.autoApprove ? 'on' : 'off'}
              </Text>
            </Text>
            <Text>
              <Text color={C.DIM}>{'目录  '}</Text>
              <Text color={C.SUBTLE}>{truncate(line.cwd, Math.max(24, cols - 32))}</Text>
            </Text>
          </Box>
        </Box>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {line.tips.map((t, i) => (
          <Text key={`tip${i}`} color={C.DIM}>
            {`  ✎ ${t}`}
          </Text>
        ))}
        <Text color={C.MUTED}>{`  ${COPYRIGHT}`}</Text>
      </Box>
    </Box>
  );
}

/** 一轮结束统计：耗时、完成时刻、步数、工具数、token 用量。 */
function Stats({ line }: { line: Extract<DisplayLine, { kind: 'stats' }> }) {
  const secs = line.elapsedMs / 1000;
  const dur = secs < 60 ? `${secs.toFixed(1)}s` : `${Math.floor(secs / 60)}m${(secs % 60).toFixed(0)}s`;
  const total = line.tokensIn + line.tokensOut;

  /** 一枚「标签 + 数值」的小胶囊。 */
  const chip = (label: string, value: string, color: string) => (
    <Text key={label}>
      <Text color={C.DIM}>{`${label} `}</Text>
      <Text color={color} bold>
        {value}
      </Text>
    </Text>
  );

  return (
    <Box marginTop={1} flexDirection="column">
      <Text>
        <Text color={C.SUCCESS} bold>
          {'✓ '}
        </Text>
        <Text color={C.SUCCESS} bold>
          {'完成'}
        </Text>
        <Text color={C.DIM}>{'  '}</Text>
        {chip('', dur, C.PLAN)}
        <Text color={C.BORDER}>{' │ '}</Text>
        {chip('步数', String(line.steps), C.TEXT)}
        <Text color={C.BORDER}>{' │ '}</Text>
        {chip('工具', `${line.tools} 次`, C.TEXT)}
        {total > 0 ? (
          <>
            <Text color={C.BORDER}>{' │ '}</Text>
            {chip('token', total.toLocaleString('en-US'), C.SUBTLE)}
          </>
        ) : null}
      </Text>
      <Text color={C.MUTED}>
        {`  ${line.finishedAt}`}
        {total > 0 ? `　↑${line.tokensIn.toLocaleString('en-US')} ↓${line.tokensOut.toLocaleString('en-US')}` : ''}
      </Text>
    </Box>
  );
}

// ---------------------------------------------------------------- 工具函数

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + '…' : one;
}

/** 工具输出预览：保留前若干行，突出首行。 */
function previewOutput(out: string): string {
  const lines = out.split('\n').filter((l) => l.trim() !== '');
  if (!lines.length) return '(无输出)';
  if (lines.length <= 6) return lines.join(' │ ');
  return lines.slice(0, 5).join(' │ ') + ` │ …(+${lines.length - 5} 行)`;
}
