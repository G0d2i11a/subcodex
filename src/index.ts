import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Codex, type ThreadEvent, type ThreadItem } from "@openai/codex-sdk";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

// ============ Stall Detection Configuration (Defaults) ============
const DEFAULT_STALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_RECOVERY_ATTEMPTS = 2;

interface RecoveryInfo {
  attempted: boolean;
  attempts: number;
  recovered: boolean;
  lastError?: string;
}

interface EventProcessingResult {
  items: ThreadItem[];
  threadId: string | null;
  finalResponse: string;
  usage: { input_tokens: number; output_tokens: number } | null;
  stalled: boolean;
  error?: string;
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function writeProgress(logPath: string, message: string) {
  const line = `[${formatTimestamp()}] ${message}\n`;
  fs.appendFileSync(logPath, line);
  console.error(line.trim());
}

function clearProgressLog(logPath: string) {
  const logDir = path.dirname(logPath);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  fs.writeFileSync(logPath, `=== Codex Session Started at ${formatTimestamp()} ===\n`);
}

type ResultLevel = "PASS" | "FAIL" | "ERROR" | "TIMEOUT";

function determineResultLevel(
  items: ThreadItem[],
  hasError: boolean,
  errorMessage?: string
): ResultLevel {
  if (hasError) {
    if (errorMessage?.includes("timeout") || errorMessage?.includes("aborted")) {
      return "TIMEOUT";
    }
    return "ERROR";
  }

  // If there's a final agent message, consider it a success
  // Codex often tries Linux commands first on Windows, fails, then uses PowerShell
  // This is normal learning behavior, not a failure
  const hasAgentMessage = items.some((i) => i.type === "agent_message");
  if (hasAgentMessage) {
    return "PASS";
  }

  // No final message - check for critical failures
  const errorItems = items.filter((i) => i.type === "error");
  const failedFileChanges = items.filter(
    (i) => i.type === "file_change" && i.status === "failed"
  );

  if (errorItems.length > 0 || failedFileChanges.length > 0) {
    return "FAIL";
  }

  return "PASS";
}

function renameLogWithLevel(logPath: string, level: ResultLevel): string {
  // progress-abc123.log -> progress-abc123-PASS.log
  const dir = path.dirname(logPath);
  const ext = path.extname(logPath);
  const base = path.basename(logPath, ext);
  const newPath = path.join(dir, `${base}-${level}${ext}`);

  try {
    if (fs.existsSync(logPath)) {
      fs.renameSync(logPath, newPath);
    }
  } catch {
    // If rename fails, keep original
    return logPath;
  }
  return newPath;
}

function formatItem(item: ThreadItem): string {
  switch (item.type) {
    case "agent_message":
      return `[Message] ${item.text.substring(0, 100)}${item.text.length > 100 ? "..." : ""}`;
    case "reasoning":
      return `[Reasoning] ${item.text.substring(0, 100)}${item.text.length > 100 ? "..." : ""}`;
    case "command_execution":
      return `[Command] ${item.command} (status: ${item.status}, exit: ${item.exit_code ?? "running"})`;
    case "file_change":
      return `[FileChange] ${item.changes.map(c => `${c.kind}: ${c.path}`).join(", ")} (${item.status})`;
    case "mcp_tool_call":
      return `[MCP] ${item.server}/${item.tool} (${item.status})`;
    case "web_search":
      return `[WebSearch] ${item.query}`;
    case "todo_list":
      return `[TodoList] ${item.items.length} items`;
    case "error":
      return `[Error] ${item.message}`;
    default:
      return `[Unknown] ${(item as any).type}`;
  }
}

// ============ Stall Detection Event Processing ============

/**
 * Process events with stall detection.
 * If no event is received within STALL_TIMEOUT_MS, marks as stalled.
 */
async function processEventsWithStallDetection(
  events: AsyncIterable<ThreadEvent>,
  progressLog: string,
  stallTimeoutMs: number = DEFAULT_STALL_TIMEOUT_MS
): Promise<EventProcessingResult> {
  const items: ThreadItem[] = [];
  let threadId: string | null = null;
  let finalResponse = "";
  let usage: { input_tokens: number; output_tokens: number } | null = null;
  let stalled = false;

  const iterator = events[Symbol.asyncIterator]();

  while (true) {
    // Create a timeout promise
    let timeoutId: NodeJS.Timeout;
    const timeoutPromise = new Promise<{ done: true; value: undefined; timeout: true }>((resolve) => {
      timeoutId = setTimeout(() => {
        resolve({ done: true, value: undefined, timeout: true });
      }, stallTimeoutMs);
    });

    // Race between next event and timeout
    const result = await Promise.race([
      iterator.next().then((r) => ({ ...r, timeout: false })),
      timeoutPromise,
    ]);

    clearTimeout(timeoutId!);

    // Check if timed out
    if (result.timeout) {
      writeProgress(progressLog, `⚠️ STALL DETECTED: No activity for ${stallTimeoutMs / 1000 / 60} minutes`);
      stalled = true;
      break;
    }

    // Check if done
    if (result.done) {
      break;
    }

    const event = result.value as ThreadEvent;

    // Process event (same logic as before)
    switch (event.type) {
      case "thread.started":
        threadId = event.thread_id;
        writeProgress(progressLog, `Thread started: ${threadId}`);
        break;

      case "turn.started":
        writeProgress(progressLog, "Turn started");
        break;

      case "item.started":
        writeProgress(progressLog, `Started: ${formatItem(event.item)}`);
        break;

      case "item.updated":
        writeProgress(progressLog, `Updated: ${formatItem(event.item)}`);
        break;

      case "item.completed":
        writeProgress(progressLog, `Completed: ${formatItem(event.item)}`);
        items.push(event.item);
        if (event.item.type === "agent_message") {
          finalResponse = event.item.text;
        }
        break;

      case "turn.completed":
        usage = {
          input_tokens: event.usage.input_tokens,
          output_tokens: event.usage.output_tokens,
        };
        writeProgress(progressLog, `Turn completed. Tokens: ${event.usage.input_tokens} in / ${event.usage.output_tokens} out`);
        break;

      case "turn.failed":
        writeProgress(progressLog, `Turn failed: ${event.error.message}`);
        break;

      case "error":
        writeProgress(progressLog, `Error: ${event.message}`);
        break;
    }
  }

  return { items, threadId, finalResponse, usage, stalled };
}

/**
 * Attempt to recover a stalled session using codex-reply.
 */
async function attemptRecovery(
  threadId: string,
  progressLog: string,
  attempt: number,
  maxAttempts: number,
  stallTimeoutMs: number
): Promise<EventProcessingResult & { recoverySuccess: boolean }> {
  writeProgress(progressLog, `🔄 Recovery attempt ${attempt}/${maxAttempts}...`);

  const recoveryPrompt = `检测到执行停滞。请检查当前状态并继续执行任务。
如果遇到阻塞，请报告具体问题：
1. 最后执行的操作是什么？
2. 是否遇到阻塞？
3. 需要什么帮助继续？`;

  try {
    const codex = new Codex();
    const thread = codex.resumeThread(threadId);
    const { events } = await thread.runStreamed(recoveryPrompt);

    const result = await processEventsWithStallDetection(events, progressLog, stallTimeoutMs);

    if (result.stalled) {
      writeProgress(progressLog, `❌ Recovery attempt ${attempt} failed: still stalled`);
      return { ...result, recoverySuccess: false };
    }

    writeProgress(progressLog, `✅ Recovery attempt ${attempt} succeeded`);
    return { ...result, recoverySuccess: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    writeProgress(progressLog, `❌ Recovery attempt ${attempt} error: ${errorMessage}`);
    return {
      items: [],
      threadId,
      finalResponse: "",
      usage: null,
      stalled: true,
      error: errorMessage,
      recoverySuccess: false,
    };
  }
}

/**
 * Run Codex with automatic stall detection and recovery.
 */
async function runWithStallRecovery(
  events: AsyncIterable<ThreadEvent>,
  progressLog: string,
  getThreadId: () => string | null,
  stallTimeoutMs: number = DEFAULT_STALL_TIMEOUT_MS,
  maxRecoveryAttempts: number = DEFAULT_MAX_RECOVERY_ATTEMPTS
): Promise<{
  result: EventProcessingResult;
  recovery: RecoveryInfo;
}> {
  // First attempt
  let result = await processEventsWithStallDetection(events, progressLog, stallTimeoutMs);

  const recovery: RecoveryInfo = {
    attempted: false,
    attempts: 0,
    recovered: false,
  };

  // If stalled and we have a threadId, attempt recovery
  const threadId = result.threadId || getThreadId();
  if (result.stalled && threadId) {
    recovery.attempted = true;

    for (let attempt = 1; attempt <= maxRecoveryAttempts; attempt++) {
      recovery.attempts = attempt;

      const recoveryResult = await attemptRecovery(threadId, progressLog, attempt, maxRecoveryAttempts, stallTimeoutMs);

      if (recoveryResult.recoverySuccess) {
        recovery.recovered = true;
        // Merge items from recovery
        result = {
          ...recoveryResult,
          items: [...result.items, ...recoveryResult.items],
          threadId: threadId,
        };
        break;
      }

      recovery.lastError = recoveryResult.error || "Still stalled after recovery attempt";
    }

    if (!recovery.recovered) {
      writeProgress(progressLog, `🛑 All recovery attempts failed. Manual intervention required.`);
    }
  }

  return { result, recovery };
}

const server = new Server(
  {
    name: "subcodex",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "run",
        description: "Run a Codex session with streaming progress, stall detection, and auto-recovery",
        inputSchema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "The prompt to send to Codex",
            },
            cwd: {
              type: "string",
              description: "Working directory for the session",
            },
            model: {
              type: "string",
              description: "Optional model override (e.g. 'gpt-5.2')",
            },
            sandboxMode: {
              type: "string",
              enum: ["read-only", "workspace-write", "danger-full-access"],
              description: "Sandbox mode for command execution",
            },
            approvalPolicy: {
              type: "string",
              enum: ["never", "on-request", "on-failure", "untrusted"],
              description: "Approval policy for commands",
            },
            level: {
              type: "string",
              enum: ["L1", "L2", "L3", "L4"],
              description: "Execution level: L1=Executor, L2=Builder, L3=Autonomous, L4=Specialist",
            },
            stallTimeoutMinutes: {
              type: "number",
              description: "Minutes of inactivity before detecting stall (default: 5)",
            },
            maxRecoveryAttempts: {
              type: "number",
              description: "Max auto-recovery attempts when stalled (default: 2)",
            },
          },
          required: ["prompt"],
        },
      },
      {
        name: "reply",
        description: "Continue a Codex conversation by providing the thread id and prompt",
        inputSchema: {
          type: "object",
          properties: {
            threadId: {
              type: "string",
              description: "The thread id for this Codex session",
            },
            prompt: {
              type: "string",
              description: "The next user prompt to continue the conversation",
            },
            level: {
              type: "string",
              enum: ["L1", "L2", "L3", "L4"],
              description: "Execution level (optional, for log naming): L1=Executor, L2=Builder, L3=Autonomous, L4=Specialist",
            },
            stallTimeoutMinutes: {
              type: "number",
              description: "Minutes of inactivity before detecting stall (default: 5)",
            },
            maxRecoveryAttempts: {
              type: "number",
              description: "Max auto-recovery attempts when stalled (default: 2)",
            },
          },
          required: ["threadId", "prompt"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "run") {
    const {
      prompt,
      cwd,
      model,
      sandboxMode,
      approvalPolicy,
      level,
      stallTimeoutMinutes,
      maxRecoveryAttempts,
    } = args as {
      prompt: string;
      cwd?: string;
      model?: string;
      sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
      approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
      level?: "L1" | "L2" | "L3" | "L4";
      stallTimeoutMinutes?: number;
      maxRecoveryAttempts?: number;
    };

    const effectiveLevel = level || "L2";
    const stallTimeoutMs = (stallTimeoutMinutes ?? 5) * 60 * 1000;
    const maxAttempts = maxRecoveryAttempts ?? DEFAULT_MAX_RECOVERY_ATTEMPTS;
    const sessionId = crypto.randomUUID().slice(0, 8);
    const progressLog = path.join(os.homedir(), ".claude", "codex-logs", `progress-${effectiveLevel}-${sessionId}.log`);

    clearProgressLog(progressLog);
    writeProgress(progressLog, `Prompt: ${prompt}`);
    if (cwd) writeProgress(progressLog, `Working directory: ${cwd}`);
    writeProgress(progressLog, `Stall timeout: ${stallTimeoutMinutes ?? 5} min, Max recovery: ${maxAttempts}`);

    try {
      const codex = new Codex();
      const thread = codex.startThread({
        workingDirectory: cwd,
        model,
        sandboxMode,
        approvalPolicy,
      });

      writeProgress(progressLog, "Starting Codex session (with stall detection)...");

      const { events } = await thread.runStreamed(prompt);

      // Use stall detection and auto-recovery
      let capturedThreadId: string | null = null;
      const { result, recovery } = await runWithStallRecovery(
        events,
        progressLog,
        () => capturedThreadId,
        stallTimeoutMs,
        maxAttempts
      );

      const { items, threadId, finalResponse, usage, stalled } = result;
      capturedThreadId = threadId;

      writeProgress(progressLog, "=== Session Complete ===");

      // Determine result level (stalled without recovery = TIMEOUT)
      const hasUnrecoveredStall = stalled && !recovery.recovered;
      const resultLevel = hasUnrecoveredStall
        ? "TIMEOUT"
        : determineResultLevel(items, false);
      writeProgress(progressLog, `Result: ${resultLevel}`);

      // Build summary
      const commandItems = items.filter(i => i.type === "command_execution");
      const fileItems = items.filter(i => i.type === "file_change");
      const mcpItems = items.filter(i => i.type === "mcp_tool_call");

      // Rename log with result level (keep for non-PASS results)
      const finalLogPath = renameLogWithLevel(progressLog, resultLevel);
      if (resultLevel === "PASS") {
        try { fs.unlinkSync(finalLogPath); } catch {}
      }

      const summary = {
        threadId,
        level: effectiveLevel,
        content: finalResponse,
        progressLog: resultLevel !== "PASS" ? finalLogPath : null,
        rolloutFile: threadId
          ? `~/.codex/sessions/${new Date().toISOString().slice(0, 10).replace(/-/g, "/")}/rollout-*${threadId.slice(-12)}*.jsonl`
          : null,
        stats: {
          totalItems: items.length,
          commands: commandItems.length,
          fileChanges: fileItems.length,
          mcpCalls: mcpItems.length,
          usage,
        },
        filesModified: fileItems.flatMap(i =>
          i.type === "file_change" ? i.changes.map(c => `${c.kind}: ${c.path}`) : []
        ),
        recovery: recovery.attempted ? recovery : undefined,
        needsUserInput: hasUnrecoveredStall,
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      writeProgress(progressLog, `Error: ${errorMessage}`);

      // Determine error level and rename log
      const resultLevel = determineResultLevel([], true, errorMessage);
      writeProgress(progressLog, `Result: ${resultLevel}`);
      renameLogWithLevel(progressLog, resultLevel);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: `Codex Exec exited with code 1: ${errorMessage}` }, null, 2),
          },
        ],
      };
    }
  }

  if (name === "reply") {
    const { threadId, prompt, level, stallTimeoutMinutes, maxRecoveryAttempts } = args as {
      threadId: string;
      prompt: string;
      level?: string;
      stallTimeoutMinutes?: number;
      maxRecoveryAttempts?: number;
    };

    const effectiveLevel = level || "L2";
    const stallTimeoutMs = (stallTimeoutMinutes ?? 5) * 60 * 1000;
    const maxAttempts = maxRecoveryAttempts ?? DEFAULT_MAX_RECOVERY_ATTEMPTS;
    const sessionId = crypto.randomUUID().slice(0, 8);
    const progressLog = path.join(os.homedir(), ".claude", "codex-logs", `progress-${effectiveLevel}-${sessionId}.log`);

    clearProgressLog(progressLog);
    writeProgress(progressLog, `Continuing thread: ${threadId}`);
    writeProgress(progressLog, `Prompt: ${prompt}`);
    writeProgress(progressLog, `Stall timeout: ${stallTimeoutMinutes ?? 5} min, Max recovery: ${maxAttempts}`);

    try {
      const codex = new Codex();
      const thread = codex.resumeThread(threadId);

      writeProgress(progressLog, "Resuming Codex session (with stall detection)...");

      const { events } = await thread.runStreamed(prompt);

      // Use stall detection and auto-recovery
      const { result, recovery } = await runWithStallRecovery(
        events,
        progressLog,
        () => threadId,
        stallTimeoutMs,
        maxAttempts
      );

      const { items, finalResponse, usage, stalled } = result;

      writeProgress(progressLog, "=== Session Complete ===");

      // Determine result level (stalled without recovery = TIMEOUT)
      const hasUnrecoveredStall = stalled && !recovery.recovered;
      const resultLevel = hasUnrecoveredStall
        ? "TIMEOUT"
        : determineResultLevel(items, false);
      writeProgress(progressLog, `Result: ${resultLevel}`);

      const commandItems = items.filter(i => i.type === "command_execution");
      const fileItems = items.filter(i => i.type === "file_change");
      const mcpItems = items.filter(i => i.type === "mcp_tool_call");

      // Rename log with result level (keep for non-PASS results)
      const finalLogPath = renameLogWithLevel(progressLog, resultLevel);
      if (resultLevel === "PASS") {
        try { fs.unlinkSync(finalLogPath); } catch {}
      }

      const summary = {
        threadId,
        level: effectiveLevel,
        content: finalResponse,
        progressLog: resultLevel !== "PASS" ? finalLogPath : null,
        stats: {
          totalItems: items.length,
          commands: commandItems.length,
          fileChanges: fileItems.length,
          mcpCalls: mcpItems.length,
          usage,
        },
        filesModified: fileItems.flatMap(i =>
          i.type === "file_change" ? i.changes.map(c => `${c.kind}: ${c.path}`) : []
        ),
        recovery: recovery.attempted ? recovery : undefined,
        needsUserInput: hasUnrecoveredStall,
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      writeProgress(progressLog, `Error: ${errorMessage}`);

      // Determine error level and rename log
      const resultLevel = determineResultLevel([], true, errorMessage);
      writeProgress(progressLog, `Result: ${resultLevel}`);
      renameLogWithLevel(progressLog, resultLevel);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: `Codex Exec exited with code 1: ${errorMessage}` }, null, 2),
          },
        ],
      };
    }
  }

  throw new Error(`Unknown tool: ${name}`);
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Subcodex MCP Server started");
}

main().catch(console.error);
