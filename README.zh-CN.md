# subcodex

让 Claude Code 使用 OpenAI Codex 作为子代理的 MCP 服务器，支持卡顿检测和自动恢复。

[English](README.md)

## 为什么需要 subcodex？

Claude Code 和 Codex 各有所长：

| 角色 | Claude Code | Codex |
|------|-------------|-------|
| 比喻 | 懂需求的产品经理 | 闭关修炼的技术大神 |
| 优势 | 规划、沟通、理解上下文 | 写代码、调试、实现 |
| 擅长 | 拆解任务、编写规范、验证结果 | 编写代码、修复 bug、重构 |

**subcodex** 将两者结合，让 Claude Code 调度 Codex 作为子代理：
- Claude Code 负责"做什么"和"为什么"（需求、规划、验证）
- Codex 负责"怎么做"（实现、调试）

这种组合比单独使用任何一个工具效果都好。

## 功能特性

- 运行 Codex 会话并流式输出进度
- 自动卡顿检测（可配置超时时间）
- 卡顿时自动尝试恢复
- 进度日志保存到 `~/.claude/codex-logs/`
- 通过 `codex-reply` 支持会话续接

## 使用模式

在 `CLAUDE.md` 中配置，控制何时使用 subcodex：

### 模式 1：全代理模式

所有代码修改都通过 subcodex。Claude 只做分析、规划和验证。

```markdown
## Subagent Mode: full-subagent

所有代码修改必须通过 `mcp__subcodex__run`：
- Claude：分析、规划、编写 Codex Contract、验证结果
- Subcodex：所有文件编辑、代码生成、重构
```

### 模式 2：目录分工模式

不同目录由不同执行者处理。

```markdown
## Subagent Mode: directory-based

| 范围 | 执行者 |
|------|--------|
| `apps/web/**/*` | Claude 直接执行 |
| `apps/api/**/*`, `packages/**/*` | subcodex |
| 文档、配置 | Claude 直接执行 |
```

### 模式 3：降级模式

Claude 处理所有任务，失败时降级到 subcodex。

```markdown
## Subagent Mode: fallback

- Claude 直接尝试所有代码修改
- 失败 2 次后 → 自动使用 subcodex
- Windows 文件锁错误 → 立即使用 subcodex
```

## 安装

### 从 npm 安装

```bash
npx subcodex-mcp
```

### 从源码安装

```bash
git clone https://github.com/G0d2i11a/subcodex.git
cd subcodex
pnpm install
pnpm build
```

## 配置

添加到 Claude Code MCP 配置 (`~/.claude.json`)：

```json
{
  "mcpServers": {
    "subcodex": {
      "command": "npx",
      "args": ["-y", "subcodex-mcp"],
      "env": {},
      "type": "stdio"
    }
  }
}
```

或本地开发：

```json
{
  "mcpServers": {
    "subcodex": {
      "command": "node",
      "args": ["/path/to/subcodex/dist/index.js"],
      "env": {},
      "type": "stdio"
    }
  }
}
```

## 工具

### `run`

启动新的 Codex 会话。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prompt` | string | 是 | 发送给 Codex 的提示词 |
| `cwd` | string | 否 | 会话的工作目录 |
| `model` | string | 否 | 模型覆盖（如 'gpt-5.2'） |
| `sandboxMode` | string | 否 | `read-only`、`workspace-write` 或 `danger-full-access` |
| `approvalPolicy` | string | 否 | `never`、`on-request`、`on-failure` 或 `untrusted` |
| `level` | string | 否 | 执行级别：`L1`、`L2`、`L3`、`L4`（用于日志命名） |
| `stallTimeoutMinutes` | number | 否 | 检测卡顿的超时分钟数（默认：5） |
| `maxRecoveryAttempts` | number | 否 | 卡顿时最大自动恢复次数（默认：2） |

### `reply`

继续现有的 Codex 会话。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `threadId` | string | 是 | 上一次会话的线程 ID |
| `prompt` | string | 是 | 继续会话的下一个提示词 |
| `level` | string | 否 | 日志命名的执行级别 |
| `stallTimeoutMinutes` | number | 否 | 检测卡顿的超时分钟数（默认：5） |
| `maxRecoveryAttempts` | number | 否 | 卡顿时最大自动恢复次数（默认：2） |

## 卡顿检测

服务器监控 Codex 会话的活动。如果在超时时间内没有收到事件：

1. 标记会话为卡顿
2. 发送恢复提示尝试自动恢复
3. 最多重试 `maxRecoveryAttempts` 次
4. 如果所有恢复尝试都失败，返回 `TIMEOUT` 状态和 `needsUserInput: true`

### 处理 `needsUserInput`

当响应包含 `needsUserInput: true` 时，Claude 应使用 `AskUserQuestion` 询问用户如何继续。在 CLAUDE.md 中添加此规则：

```markdown
## Subcodex 卡顿处理

当 `mcp__subcodex__run` 返回 `needsUserInput: true` 时：
- 使用 AskUserQuestion 询问用户如何继续
- 选项：重试、跳过当前任务、手动干预
```

## 响应格式

```json
{
  "threadId": "abc123...",
  "level": "L2",
  "content": "Codex 的最终响应",
  "progressLog": "~/.claude/codex-logs/progress-L2-xxx-PASS.log",
  "stats": {
    "totalItems": 10,
    "commands": 3,
    "fileChanges": 2,
    "mcpCalls": 0,
    "usage": {
      "input_tokens": 1000,
      "output_tokens": 500
    }
  },
  "filesModified": ["create: src/foo.ts", "modify: src/bar.ts"],
  "recovery": {
    "attempted": false
  },
  "needsUserInput": false
}
```

卡顿且恢复失败时：

```json
{
  "threadId": "abc123...",
  "level": "L2",
  "content": "",
  "progressLog": "~/.claude/codex-logs/progress-L2-xxx-TIMEOUT.log",
  "recovery": {
    "attempted": true,
    "attempts": 2,
    "recovered": false,
    "lastError": "恢复尝试后仍然卡顿"
  },
  "needsUserInput": true
}
```

## 结果级别

日志文件以结果级别后缀重命名：
- `PASS` - 成功（日志文件删除）
- `FAIL` - 命令或文件修改失败
- `ERROR` - 发生异常
- `TIMEOUT` - 卡顿且恢复失败

## 要求

- Node.js 18+
- 已配置 OpenAI Codex SDK 凭证

## 许可证

MIT
