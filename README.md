# AIGPart Agent

> 从零实现的终端 AI 编程 agent —— TypeScript + Ink，逐像素的品牌 TUI，OpenAI 兼容协议。

![version](https://img.shields.io/badge/version-0.4.0-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)

AIGPart Agent 是一个跑在终端里的编程助手：读代码、改文件、执行命令、跑测试、查资料，
把「想法 → 改动 → 验证」这一整条链路交给模型自主完成，过程全程可见。

它不套壳 Claude Code，也不依赖 Anthropic SDK / LangChain / Vercel AI SDK —— agent loop、
工具集、Markdown 渲染、MCP 客户端、沙箱全部自行实现，只对接 OpenAI 兼容的
`/v1/chat/completions` 端点，因此任何兼容该协议的服务（DeepSeek、GLM、vLLM、Ollama、
自建网关）都能直接使用。

官网：[aigpart.com](https://aigpart.com)

---

## 特性

<table>
<tr><td width="50%" valign="top">

**自主 agent loop**
多步推理 + 工具调用循环，一次任务最多 60 步；单条消息里的多个工具调用用 worker 池并行执行。

**七件套工具 + MCP**
`bash` / `read` / `write` / `edit` / `ls` / `grep` / `webfetch`，加上零依赖 MCP 客户端
（stdio + streamable HTTP），外部工具无缝并入。

**危险的活先问你**
`rm -rf`、`git push -f`、`mkfs`、`curl | sh` 等模式命中后弹确认框；headless 模式默认拒绝。

**bwrap 沙箱**
`bash` 支持 `sandbox: true`：只读根、断网、清空环境、unshare 全部命名空间，
可按路径白名单单独放开（文件级，不整目录）。

</td><td width="50%" valign="top">

**真·Markdown 渲染**
标题、嵌套列表、表格（CJK 宽度对齐）、引用、分隔线，代码块带行号与多语言语法高亮。

**上下文自动压缩**
超阈值时调模型把早期消息摘要成中文结论，写回 system 段，不污染历史。

**会话与标题**
自动落盘、模型生成短标题、`--resume` 恢复、`--titles` 批量补标题。

**子 agent 与 skill**
`task` 工具派发独立上下文的子任务；skill 目录惰性加载，按需读取正文。

</td></tr>
</table>

## 安装

```bash
git clone https://github.com/aowind/aigpart-agent.git
cd aigpart-agent
npm install
npm run build
node dist/index.js
```

装成全局命令：

```bash
npm link        # 之后直接敲 aigpart
```

要求 Node ≥ 18（用到原生 `fetch` 与 `AbortSignal.timeout`）。

## 配置

零配置即可运行，默认连本机 `http://127.0.0.1:8787/v1`。改用其他服务：

```bash
export DSA_BASE_URL=https://api.deepseek.com/v1
export DSA_API_KEY=sk-xxxxxxxx
export DSA_MODEL=deepseek-chat
```

或写配置文件 `~/.config/ds-agent/config.json`：

```json
{
  "model": "deepseek-chat",
  "models": [
    { "id": "deepseek-chat", "label": "DeepSeek Chat" },
    { "id": "glm-4v", "label": "GLM-4V", "vision": true }
  ],
  "maxSteps": 60,
  "compactThreshold": 200000,
  "toolConcurrency": 4,
  "permission": {
    "askTools": ["bash"],
    "denyPaths": [".git", "~/.ssh"]
  },
  "mcpServers": [
    {
      "name": "filesystem",
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed"]
    }
  ]
}
```

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `DSA_BASE_URL` | `http://127.0.0.1:8787/v1` | OpenAI 兼容端点 |
| `DSA_API_KEY` | `local-zai-fallback-proxy` | API key |
| `DSA_MODEL` | `thub-auto` | 模型名 |

`models[].vision: true` 标记视觉模型，之后用 `@图片路径` 就能让模型看图。

## 用法

```bash
aigpart                              # 交互式 TUI
aigpart "帮我看看这个目录里有什么"      # 一次性执行
aigpart --resume <id>                # 恢复会话
aigpart --list                       # 列出历史会话
aigpart --titles                     # 为缺标题的历史会话批量补标题
aigpart --model deepseek-chat        # 指定模型
aigpart --max-steps 40               # 每轮最多工具步数
aigpart --plan                       # 计划模式启动
aigpart --auto                       # 自动放行危险命令
```

### 交互命令

| 命令 | 作用 |
|---|---|
| `/model [id]` | 切换模型（不带参数列出可选） |
| `/plan` | 计划模式：只读调查 → 给方案 → 批准后执行 |
| `/auto` | 危险命令自动放行开关 |
| `/tools` | 列出当前工具（含 MCP） |
| `/sessions` | 列出历史会话 |
| `/clear` | 清空当前上下文 |
| `/help` | 命令与快捷键 |
| `/quit` | 退出 |

| 快捷键 | 作用 |
|---|---|
| `Enter` | 发送 |
| `Esc` | 清空输入 / 运行中中断 |
| `Shift+Tab` | 切换 normal ⇄ plan |
| `←` `→` | 移动光标 |
| `Backspace` | 删除 |

`@路径` 引用文件或图片：图片会以多模态形式进入上下文，视觉模型直接识别内容。

## 界面

```
                 ▄▄████████████▄▄
              ▄█▀                ▀█▄        AIGPart Agent  v0.4.0
            ▄█      ▄█▄█▄█▄        █▄      终端 AI 编程助手
           ██     ██████████        ▀█
           ██  ▄▄▄██████████▄▄▄▄▄    █      模型  deepseek-chat
           ██  ████████████████████  █      模式  normal   auto off
           ██  ████▄▄████████▄▄█████  █     目录  ~/projects/demo
           ██  █████████████████████  █
           ██  ▀█████████████████▀   █
           ██                ▄       █
           ▀█       ██  ██  ██  ██   █▀
            ▀█▄                    ▄█▀
              ▀▀█▄▄▄▄▄▄▄▄▄▄▄▄▄▄█▀▀

  ✎ 输入 / 打开命令菜单，/help 查看全部命令
  ✎ Shift+Tab 在 normal 与 plan 模式之间切换
  © 2026 AIGPart · aigpart.com · MIT License

❯ 帮我把 utils.ts 里的重复逻辑抽成一个函数

✻ 好的，先看一下当前的实现。

⏺ read(src/utils.ts)                                      0.1s
  ⎿  1  import { parse } from './parser'
     2  import { format } from './format'
     ...

⏺ edit(src/utils.ts)                                      0.2s
  ⎿  已修改 src/utils.ts（替换 2 处）

⠹ 处理中  ·  8s  ·  第 3 步  ·  正在回复  ·  已输出 106 字
  ⎿  工具调用并行执行，结果按原始顺序回填

────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────
  running · auto off · deepseek-chat        Esc 中断

✓ 完成   8.4s │ 步数 3 │ 工具 2 次 │ token 11,594
  23:17:02　↑10,570 ↓1,024
```

- **启动横幅**：品牌 logo 由 `aigpart.com` 的 favicon 逐像素采样成半块字符画（24×24 像素 → 24×12 字符，每个格子独立前景/背景色），右侧是名称、版本、模型、模式、目录。
- **用户输入**：亮金色加粗，与助手回复明确区分。
- **工具调用**：`⏺ 工具名(参数)` + 耗时，输出以 `⎿` 缩进预览。
- **实时进度**：spinner、耗时、步数、当前动作（`读取 …` / `执行命令 …` / `正在回复`）、已输出字数，下方轮播操作提示。
- **结束统计**：耗时、步数、工具调用次数、token 用量、完成时刻。
- **底部输入区**：固定贴底，上下横线，状态栏显示运行模式 / auto 开关 / 当前模型 / 随状态变化的快捷键提示。

> **关于思考过程**：客户端已支持解析 `reasoning_content` / `reasoning` 字段并实时渲染成灰色「✻ 思考中…」块。是否出现取决于上游服务是否透传该字段——只返回 `content` 的服务不会显示。

## 架构

```
src/
  llm/          OpenAI 兼容客户端（SSE 流式解析、多模态 content、usage 统计）
  agent/        agent loop、会话持久化、skill、subagent、@引用、系统提示词、标题生成
  tools/        bash（危险命令拦截 + bwrap 沙箱）/ read / write / edit / ls / grep / webfetch
  mcp/          零依赖 MCP 客户端（stdio 指数退避重连 + streamable HTTP）
  ui/ink/       Ink TUI：App 组件、UiModel 状态 store、Markdown 渲染器、主题、logo
  index.ts      入口（TUI / headless / 会话管理）
  config.ts     配置加载
```

agent loop（`src/agent/agent.ts`）：

```
用户输入（经 @引用展开）→ 注入 messages
  └─ 循环（最多 maxSteps 步）：
       组装 system（+ plan 后缀 + 压缩摘要）+ messages → 流式请求
       ├─ 无 tool_calls → 结束，返回文本
       └─ 有 tool_calls → 并行执行（plan 拦截 / 危险命令确认）→ 结果追加 → 继续
       消息超阈值 → 调模型把早期消息压成摘要（maybeCompact）
```

### 设计取舍

- **流式决策**：每步用流式接口，文本逐段回显；工具调用在流结束后一并给出。兼容 token 级流与「整段下发」式流。
- **并行工具**：同一条 assistant 消息里的多个 `tool_calls` 由 worker 池并发执行（`toolConcurrency` 上限），结果按原始顺序回填。
- **子 agent 隔离**：`task` 复用同一 client 与工具集，但独立消息历史，只回传最终摘要，不污染父上下文。
- **skill 惰性加载**：只在系统提示里列名称与描述，正文通过 `skill` 工具按需读取。
- **零依赖渲染**：Markdown 解析器、语法高亮、显示宽度计算（CJK 全角按 2 列）全部手写，不引入 marked / cli-highlight。

## 开发

```bash
npm run build      # 编译到 dist/
npm run dev        # tsc --watch
npm start          # 运行编译产物
```

改动主要集中在 `src/`，构建产物 `dist/` 不进版本库。

## 许可证

[MIT](LICENSE) © 2026 AIGPart · [aigpart.com](https://aigpart.com)
