# subcodex

MCP server for Claude Code to use OpenAI Codex as a subagent, with stall detection and auto-recovery.

[中文文档](README.zh-CN.md)

## Why subcodex?

Claude Code and Codex have complementary strengths:

| Role | Claude Code | Codex |
|------|-------------|-------|
| Analogy | Product Manager who understands requirements | Technical expert in deep focus |
| Strengths | Planning, communication, context understanding | Coding, debugging, implementation |
| Best at | Breaking down tasks, writing specs, verification | Writing code, fixing bugs, refactoring |

**subcodex** bridges these two, letting Claude Code orchestrate Codex as a subagent:
- Claude Code handles the "what" and "why" (requirements, planning, verification)
- Codex handles the "how" (implementation, debugging)

This combination delivers better results than either tool alone.

## Features

- Run Codex sessions with streaming progress
- Automatic stall detection (configurable timeout)
- Auto-recovery attempts when stalled
- Progress logging to `~/.claude/codex-logs/`
- Thread continuation support via `codex-reply`

## Usage Modes

Configure in your `CLAUDE.md` to control when subcodex is used:

### Mode 1: Full Subagent

All code modifications go through subcodex. Claude only does analysis, planning, and verification.

```markdown
## Subagent Mode: full-subagent

All code changes must go through `mcp__subcodex__run`:
- Claude: analyze, plan, write Codex Contract, verify results
- Subcodex: all file edits, code generation, refactoring
```

### Mode 2: Directory-Based

Different directories are handled by different executors.

```markdown
## Subagent Mode: directory-based

| Scope | Executor |
|-------|----------|
| `apps/web/**/*` | Claude direct |
| `apps/api/**/*`, `packages/**/*` | subcodex |
| docs, config | Claude direct |
```

### Mode 3: Fallback

Claude handles everything, but falls back to subcodex on failure.

```markdown
## Subagent Mode: fallback

- Claude attempts all code changes directly
- After 2 failed attempts → automatically use subcodex
- Windows file lock errors → immediately use subcodex
```

## Installation

### From npm

```bash
npx subcodex-mcp
```

### From source

```bash
git clone https://github.com/G0d2i11a/subcodex.git
cd subcodex
pnpm install
pnpm build
```

## Configuration

Add to your Claude Code MCP config (`~/.claude.json`):

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

Or for local development:

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

## Tools

### `run`

Start a new Codex session.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | The prompt to send to Codex |
| `cwd` | string | No | Working directory for the session |
| `model` | string | No | Model override (e.g., 'gpt-5.2') |
| `sandboxMode` | string | No | `read-only`, `workspace-write`, or `danger-full-access` |
| `approvalPolicy` | string | No | `never`, `on-request`, `on-failure`, or `untrusted` |
| `level` | string | No | Execution level: `L1`, `L2`, `L3`, `L4` (for log naming) |
| `stallTimeoutMinutes` | number | No | Minutes of inactivity before detecting stall (default: 5) |
| `maxRecoveryAttempts` | number | No | Max auto-recovery attempts when stalled (default: 2) |

### `reply`

Continue an existing Codex conversation.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `threadId` | string | Yes | The thread ID from a previous session |
| `prompt` | string | Yes | The next prompt to continue the conversation |
| `level` | string | No | Execution level for log naming |
| `stallTimeoutMinutes` | number | No | Minutes of inactivity before detecting stall (default: 5) |
| `maxRecoveryAttempts` | number | No | Max auto-recovery attempts when stalled (default: 2) |

## Stall Detection

The server monitors Codex sessions for activity. If no events are received within the timeout period:

1. Marks the session as stalled
2. Attempts auto-recovery by sending a recovery prompt
3. Retries up to `maxRecoveryAttempts` times
4. Returns `TIMEOUT` status with `needsUserInput: true` if all recovery attempts fail

### Handling `needsUserInput`

When the response contains `needsUserInput: true`, Claude should use `AskUserQuestion` to ask the user how to proceed. Add this rule to your CLAUDE.md:

```markdown
## Subcodex Stall Handling

When `mcp__subcodex__run` returns `needsUserInput: true`:
- Use AskUserQuestion to ask the user how to proceed
- Options: retry, skip current task, manual intervention
```

## Response Format

```json
{
  "threadId": "abc123...",
  "level": "L2",
  "content": "Final response from Codex",
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

When stalled and recovery fails:

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
    "lastError": "Still stalled after recovery attempt"
  },
  "needsUserInput": true
}
```

## Result Levels

Log files are renamed with result level suffix:
- `PASS` - Success (log file deleted)
- `FAIL` - Command or file change failed
- `ERROR` - Exception occurred
- `TIMEOUT` - Stalled and recovery failed

## Requirements

- Node.js 18+
- OpenAI Codex SDK credentials configured

## License

MIT
