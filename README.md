# subcodex

MCP server for running OpenAI Codex as a subagent from Claude Code, with stall detection and auto-recovery.

## Features

- Run Codex sessions with streaming progress
- Automatic stall detection (configurable timeout)
- Auto-recovery attempts when stalled
- Progress logging to `~/.claude/codex-logs/`
- Thread continuation support via `codex-reply`

## Usage Modes

Configure in your `CLAUDE.md` to control when subcodex is used:

### Mode 1: Full Subagent (全代理模式)

All code modifications go through subcodex. Claude only does analysis, planning, and verification.

```markdown
## Subagent Mode: full-subagent

All code changes must go through `mcp__subcodex__codex`:
- Claude: analyze, plan, write Codex Contract, verify results
- Subcodex: all file edits, code generation, refactoring
```

### Mode 2: Directory-Based (目录分工模式)

Different directories are handled by different executors.

```markdown
## Subagent Mode: directory-based

| Scope | Executor |
|-------|----------|
| `apps/web/**/*` | Claude direct |
| `apps/api/**/*`, `packages/**/*` | subcodex |
| docs, config | Claude direct |
```

### Mode 3: Fallback (降级模式)

Claude handles everything, but falls back to subcodex on failure.

```markdown
## Subagent Mode: fallback

- Claude attempts all code changes directly
- After 2 failed attempts → automatically use subcodex
- Windows file lock errors → immediately use subcodex
```

## Installation

### From npm (after publishing)

```bash
npx subcodex
```

### From source

```bash
git clone https://github.com/YOUR_USERNAME/subcodex.git
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
      "args": ["-y", "subcodex"],
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

### `codex`

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

### `codex-reply`

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

When `mcp__subcodex__codex` returns `needsUserInput: true`:
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
