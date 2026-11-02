// MetaWork tool-call stall guard.
//
// This extension runs inside the Executor's own Harness process. It watches each
// in-flight tool call and interrupts only that call's process group when the
// call stops making progress entirely: no output, no CPU in its process
// subtree, and no workspace writes for the stall window. Elapsed time alone is
// never a verdict, so a slow command that keeps working is never touched.
//
// Interrupted calls finish normally, and their result is rewritten into an
// explicit tool error so the model can pick another route instead of waiting
// forever. Facts are appended to a side channel for the MetaWork host, which
// owns the Attempt-level fuse and the user-visible failure.
import { appendFileSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import {
  TOOL_STALL_FACTS_FILE,
  TOOL_STALL_SAMPLE_MS,
  TOOL_STALL_WINDOW_MS,
  ToolStallGuard,
  parsePsCpuSeconds,
  type ProcessCpuRow,
  type ToolStallFact,
} from "../tool-stall-core.js";

type AnyEvent = {
  toolCallId?: unknown;
  toolName?: unknown;
  args?: unknown;
  input?: unknown;
  partialResult?: unknown;
};

/**
 * Collaborators a host may substitute. Pi itself always calls the extension
 * with the API only; the seam exists so the wiring is testable without
 * touching real processes.
 */
export interface ToolStallGuardOverrides {
  readProcessTable?: () => Promise<readonly ProcessCpuRow[]>;
  signalGroup?: (pgid: number, signal: "SIGTERM" | "SIGKILL") => void;
  readWorkspaceStamp?: () => string;
}

export default function toolStallGuard(pi: any, overrides: ToolStallGuardOverrides = {}) {
  if (!pi || typeof pi.on !== "function") return;
  if (process.env.METACLAW_TOOL_STALL_GUARD === "0") return;

  const factsPath = process.env.METACLAW_TOOL_STALL_FACTS
    || join(process.env.HOME || ".", TOOL_STALL_FACTS_FILE);
  const windowMs = positiveInt(process.env.METACLAW_TOOL_STALL_WINDOW_MS, TOOL_STALL_WINDOW_MS);
  const sampleMs = positiveInt(process.env.METACLAW_TOOL_STALL_SAMPLE_MS, TOOL_STALL_SAMPLE_MS);
  const capturePath = join(process.env.HOME || ".", ".metaclaw-workspace-captures.jsonl");

  const guard = new ToolStallGuard({
    selfPid: process.pid,
    windowMs,
    sampleMs,
    readProcessTable: overrides.readProcessTable ?? (() => readProcessTable()),
    signalGroup: overrides.signalGroup ?? ((pgid, signal) => { process.kill(-pgid, signal); }),
    readWorkspaceStamp: overrides.readWorkspaceStamp
      ?? (() => readWorkspaceStamp(process.cwd(), capturePath)),
    writeFact: fact => appendFact(factsPath, fact),
  });

  pi.on("tool_execution_start", (event: AnyEvent) => {
    const toolCallId = text(event?.toolCallId);
    if (!toolCallId) return;
    guard.begin({
      toolCallId,
      toolName: text(event?.toolName) || "unknown",
      command: summarizeInput(event?.args),
    });
  });

  pi.on("tool_execution_update", (event: AnyEvent) => {
    const toolCallId = text(event?.toolCallId);
    if (!toolCallId) return;
    guard.observeOutput({ toolCallId, outputBytes: byteLength(event?.partialResult) });
  });

  pi.on("tool_execution_end", (event: AnyEvent) => {
    const toolCallId = text(event?.toolCallId);
    if (toolCallId) guard.end(toolCallId);
  });

  // A killed call must not look like a normal empty result: the model has to
  // learn that the route failed and that repeating it is pointless.
  pi.on("tool_result", (event: AnyEvent) => {
    const toolCallId = text(event?.toolCallId);
    if (!toolCallId || !guard.consumeInterrupted(toolCallId)) return undefined;
    const command = summarizeInput(event?.input);
    return {
      content: [{
        type: "text",
        text: [
          "metawork: tool call stalled and was interrupted",
          `The ${text(event?.toolName) || "tool"} call${command ? ` (${command})` : ""} made no progress for `
            + `${Math.round(windowMs / 60_000)} minutes: no output, no CPU activity in its process subtree, `
            + "and no workspace writes. Its process group was terminated.",
          "Do not repeat this exact call. Use a different route, or state that this source is unavailable "
            + "and continue with the rest of the work.",
        ].join("\n"),
      }],
      isError: true,
    };
  });
}

async function readProcessTable(): Promise<readonly ProcessCpuRow[]> {
  const stdout = await run("ps", ["-A", "-o", "pid=,ppid=,pgid=,time="]).catch(() => "");
  const rows: ProcessCpuRow[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const parts = line.trim().split(/\s+/u);
    if (parts.length < 4) continue;
    const pid = Number.parseInt(parts[0]!, 10);
    const ppid = Number.parseInt(parts[1]!, 10);
    const pgid = Number.parseInt(parts[2]!, 10);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgid)) continue;
    rows.push({ pid, ppid, pgid, cpuSeconds: parsePsCpuSeconds(parts.slice(3).join(" ")) });
  }
  return rows;
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/** Cheap workspace evidence: the working directory stamp plus capture writes. */
function readWorkspaceStamp(cwd: string, capturePath: string): string {
  let directory = "missing";
  try {
    directory = String(statSync(cwd).mtimeMs);
  } catch {
    // A missing cwd is itself stable evidence rather than an error.
  }
  let capture = "none";
  try {
    const stat = statSync(capturePath);
    capture = `${stat.size}:${stat.mtimeMs}`;
  } catch {
    // No capture spool means no file-tool writes so far.
  }
  return `${directory}|${capture}`;
}

function appendFact(factsPath: string, fact: ToolStallFact): void {
  try {
    appendFileSync(factsPath, `${JSON.stringify(fact)}\n`);
  } catch {
    // Observation only; never fail a tool call because a fact could not land.
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function byteLength(value: unknown): number {
  if (value === undefined || value === null) return 0;
  try {
    return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value) ?? "", "utf8");
  } catch {
    return 0;
  }
}

const INPUT_KEYS = ["command", "path", "file_path", "url", "query", "pattern"] as const;

function summarizeInput(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  for (const key of INPUT_KEYS) {
    const candidate = text(record[key]);
    if (candidate) return candidate.replace(/\s+/gu, " ").slice(0, 300);
  }
  return "";
}
