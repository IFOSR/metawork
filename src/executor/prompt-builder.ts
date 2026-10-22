import type { ExecutorInput } from './adapter.js';
import { posix, relative, win32 } from 'node:path';
import {
  MERGE_REPAIR_PROTOCOL,
  mergeRepairReportExample,
} from '../execution/merge-repair-protocol.js';

/** The only production renderer for an Executor's attempt-scoped context. */
export function buildExecutorContextPrompt(input: ExecutorInput): string {
  const { context } = input;
  const binding = input.executionBinding;
  const inputDirectory = binding
    ? (win32.isAbsolute(binding.workspacePath) && !posix.isAbsolute(binding.workspacePath)
      ? win32.relative(binding.workspacePath, binding.inputsPath).replaceAll('\\', '/')
      : relative(binding.workspacePath, binding.inputsPath)) || '.'
    : null;
  const inputReadPath = (name: string) => inputDirectory === null
    ? {} : { readPath: posix.join(inputDirectory, name) };
  const requiredCapabilities = context.currentSubtask.requiredCapabilities ?? [];
  const imageArtifactProtocol = requiredCapabilities.some(
    capability => capability === 'image-generation' || capability === 'image-editing',
  )
    ? [
        '',
        'Image artifact protocol: workspace-image-artifact-v1',
        '- Perform the requested image generation or editing through the authorized model and tools.',
        '- For edit delivery, write at least one valid PNG, JPEG, WebP, or GIF image file inside the authorized workspace.',
        '- Runtime validates the image signature and derives the final artifact paths from the workspace delta.',
      ]
    : [];
  const completionProtocol = 'protocol' in context.completionContract
    && context.completionContract.protocol === MERGE_REPAIR_PROTOCOL
    ? [
        'Completion protocol:',
        context.completionContract.marker,
        mergeRepairReportExample(context.completionContract.allowedPaths),
        'Return exactly the dedicated merge-repair report above after the Markdown summary.',
        'resolvedPaths must list exactly the authorized conflict paths that were resolved.',
        'Runtime owns Git operations and validates the changed paths and conflict state.',
        'Emit the marker exactly once, only at the end of the final response.',
      ]
    : [
        'Completion protocol:',
        context.completionContract.marker,
        JSON.stringify({
          evidence: ['<evidence that the work and checks succeeded>'],
          noChangeReason: null,
        }),
        'Return only evidence and noChangeReason. Runtime derives changed files and injects schema identity, attempt/work-unit/subtask IDs, acceptance keys, and handoff identities from the bound contract.',
        'Workspace changes are allowed for every delivery kind when needed for the task. Runtime tracks changes for Git publication and audit. File delivery follows the Planner-declared fileOutputs below, independently of edit/report.',
        'If the Subtask cannot be completed, return {"failure":{"kind":"task_failed","code":"<stable_code>","summary":"<concise explanation>"}} instead.',
        'The marker shown above is illustrative. Emit it exactly once, only at the end of your final response.',
      ];
  const lines = [
    '[MetaClaw Subtask Execution Context v1]',
    '',
    'Boundary rules:',
    '- The Task goal below is background only. It is not an instruction to execute the whole Task.',
    '- Execute only currentSubtask.goal.',
    '- Match the requested deliverable. A report delivery is an inline answer or action result, not an instruction to create a report file. For browser, installation, and other external actions, perform the action, verify its actual result, and briefly confirm it inline. Do not create Markdown reports, text logs, screenshots, or other extra documents merely to prove completion.',
    '- For code edits, make the requested changes and briefly summarize verification inline; do not add a separate report document. Keep necessary temporary work separate from declared deliverables.',
    '- Present comparisons as valid GFM tables: include a header separator row, keep each row on one line, escape literal pipes in cells, and keep tables outside code fences.',
    '- For numeric analysis, include an inline chart when it materially helps explain trends, comparisons, or proportions. Use observed/supplied data, state units and sources, distinguish estimates, and explain the conclusion in prose. Never invent values to fill a chart or force a chart into a nonnumeric answer.',
    '- Web/Desktop renders a fenced `chart` JSON block locally. Contract: version:1; type:"line"|"bar"|"area"|"pie"; title:string; labels:string[]; series:[{name:string,values:(number|null)[]}]; optional xLabel, unit, source strings. Use 1–200 labels and 1–8 uniquely named series, matching values to labels exactly; null means missing, never zero. Use line for trends, bar for comparisons, area for magnitude over time, and pie only for a nonnegative part-to-whole series with a positive total and unique labels. At most 12 charts per answer, each under 64,000 characters; numeric absolute values at most 10^15. No extra fields, JavaScript, HTML, URLs for external resources, or ECharts options. These charts are inline answer content, not file deliverables; they require no plugin, image-generation capability, or additional fileOutputs. Other text clients retain the JSON data; include a concise textual conclusion for them.',
    'Illustrative chart syntax only (replace with actual task data; never copy these example values as evidence):',
    '```chart',
    '{"version":1,"type":"bar","title":"季度收入","labels":["一季度","二季度"],"series":[{"name":"收入","values":[120,150]}],"unit":"万元","source":"用户提供的季度数据"}',
    '```',
    '- Local service delivery: when starting a service is requested, build and API-test the backend independently of unrelated UI work. Produce .metawork-service.json at the workspace root: {serviceId: <stable identifier>, command: <executable>, args: [], directory: <optional relative directory>, environmentReferences: {}, host: "127.0.0.1", port: <port>, healthPath: "/health", startupTimeoutMs: 10000, restartPolicy: "explicit"}. Omit taskId; Runtime binds the authoritative Task identity. Store only secret references. Runtime publishes code then launches from the public directory, owns health checks and process lifetime. Never claim running from a command snippet or start a persistent daemon in the isolated workspace.',
    '- Other graph nodes are out of scope. Do not execute or anticipate their full goals.',
    '- Dependency data is available only through incomingHandoffs. Use result_reference_get to read an authorized full upstream result when the edge summary is insufficient.',
    '- The workspace is the primary task and publication context, not a read-only boundary. You may read and write ordinary user-space files outside it when useful for the task, including temporary research material and caches.',
    '- Web access must go through the web_search/web_fetch tools (managed backends, bounded timeouts, result caching). Only when web_search reports 网络不可用 may you fall back to bash curl/wget as a last resort.',
    '- Do not modify the host operating system control plane, credentials, privilege boundaries, devices, container control sockets, or high-impact external systems. Request a capability for such an operation and never work around a denial.',
    '- A granted request returns a grantId. Every broker-mediated use must call use_capability with that grantId and the exact operation payload so Runtime can enforce TTL, call, and byte budgets. A grant never permits direct access.',
    '- Finish with a non-empty inline answer followed by exactly one completion marker and strict JSON until EOF. A short plain sentence is valid Markdown; no heading, report structure, or file is required. Accepted trailer forms: `<!-- metaclaw:completion:v4 -->` on its own line followed by the JSON object, or the bundled `<!-- metaclaw:completion:v4 {...} -->`. The final response must be self-contained; never split the body and the marker across multiple messages. Only when a report file is a declared deliverable may the trailer instead declare "reportPath": "<relative file path>" and leave the inline body empty; that file content then supplies the body.',
    '',
    `Task background: ${context.taskBackground.title}`,
    `Background goal: ${context.taskBackground.goal}`,
    '',
    `Current Subtask: ${context.currentSubtask.title}`,
    `Operative goal: ${context.currentSubtask.goal}`,
    `Delivery kind: ${context.currentSubtask.deliveryKind}`,
    ...(context.currentSubtask.fileOutputs === undefined ? [] : [
      `Planner-declared fileOutputs: ${JSON.stringify(context.currentSubtask.fileOutputs)}`,
      context.currentSubtask.fileOutputs.length === 0
        ? 'No file delivery is requested. Return the answer/action receipt inline. Do not create any extra report or evidence files. Requested code/configuration edits still belong in the workspace.'
        : 'Produce every declared file output, or verify an existing file when it already satisfies the request. A trailing / declares a dedicated output directory that must contain deliverable files. Put only requested deliverables there; keep scratch files, scripts and logs outside it. Only matching files are delivered to the user and artifact handoffs.',
    ]),
    `Required routing capabilities: ${
      requiredCapabilities.join(', ') || '(none)'
    }`,
    ...imageArtifactProtocol,
    'Acceptance requirements (Runtime owns their internal keys):',
    JSON.stringify(context.currentSubtask.acceptance.map(item => ({
      description: item.description,
      requiredEvidence: item.requiredEvidence,
    })), null, 2),
    '',
    'Incoming direct handoffs:',
    JSON.stringify(context.incomingHandoffs.map(handoff => ({
      items: handoff.items.map(item => item.type === 'text'
        ? { type: item.type, value: item.value }
        : item.type === 'artifact'
          ? { type: item.type, paths: item.paths }
          : {
              type: item.type,
              referenceId: item.referenceId,
              summary: item.summary,
            }),
      resultReference: handoff.resultReference ? {
        referenceId: handoff.resultReference.referenceId,
        requiredItems: handoff.resultReference.requiredItems,
        contentHash: handoff.resultReference.contentHash,
        byteLength: handoff.resultReference.byteLength,
        mediaType: handoff.resultReference.mediaType,
        completeness: handoff.resultReference.completeness,
      } : null,
    })), null, 2),
    '',
    'Outgoing handoff requirements (do not infer downstream goals):',
    JSON.stringify(context.outgoingHandoffRequirements.map(contract => ({
      requiredItems: contract.requiredItems.map(item => ({
        type: item.type,
        description: item.description,
      })),
    })), null, 2),
    '',
    'Planner-selected evidence:',
    JSON.stringify(context.selectedEvidence.map(evidence => ({
      title: evidence.title,
      content: evidence.content,
      truncated: evidence.truncated,
    })), null, 2),
    '',
    'Input file resolution:',
    ...(inputDirectory === null ? [
      '- The input directory is provided by METACLAW_INPUTS_PATH; do not guess its location.',
    ] : [
      `Input directory relative to the working directory: ${JSON.stringify(inputDirectory)}`,
      '- Each readPath below is directly usable from the working directory. relativeInputPath is relative to the input directory, NOT the working directory.',
    ]),
    '- These are the exact Planner-selected prior artifacts and current attachments, already verified and copied by Runtime. Read these copies; do not rediscover them in Conversation history or other task directories.',
    '- Do not search the whole disk, filesystem root, or user home for these inputs. If a listed input cannot be read, report the missing input and stop instead of guessing another source.',
    '- Treat inputs as read-only originals. Write revised deliverables in the working directory.',
    '',
    'Planner-selected artifact inputs:',
    JSON.stringify((context.selectedArtifacts ?? []).map(artifact => ({
      displayName: artifact.displayName,
      relativeInputPath: artifact.relativeInputPath,
      ...inputReadPath(artifact.relativeInputPath),
      mediaType: artifact.mediaType,
    })), null, 2),
    '',
    'Planner-selected attachment inputs:',
    JSON.stringify((context.selectedAttachments ?? []).map(attachment => ({
      displayName: attachment.displayName,
      relativeInputPath: attachment.relativeInputPath,
      ...inputReadPath(attachment.relativeInputPath),
      mediaType: attachment.mediaType,
    })), null, 2),
    '',
    'Attachment processing:',
    '- Attachments are opaque original files materialized under the attempt-local `inputs/` directory. MetaWork ships no document parser: process the file with your own model and tool capability.',
    '- Never read attachment bytes from an absolute host path or from outside the attempt-local inputs directory.',
    '- If you cannot process the file format, report a normalized failure instead of guessing the contents.',
    '',
    'Out-of-scope graph nodes (titles only):',
    JSON.stringify(context.outOfScopeSiblings.map(sibling => ({ title: sibling.title })), null, 2),
    '',
    `Working directory: ${context.workspaceContext.workingDirectory}`,
    `Authorized target paths: ${context.workspaceContext.targetPaths.join(', ') || '(none)'}`,
    `Evidence tool: ${context.evidenceTools.availability} — ${context.evidenceTools.reason}`,
    ...(context.recovery && context.recovery.mode !== 'fresh' ? [
      '',
      `Recovery mode: ${context.recovery.mode}`,
      'Inspect current state before continuing. Preserve confirmed work and perform only the remaining work.',
      `Recovery packet: ${JSON.stringify(modelRecoveryPacket(context.recovery.packet), null, 2)}`,
    ] : []),
    '',
    ...completionProtocol,
  ];
  return lines.join('\n');
}

function modelRecoveryPacket(packet: Record<string, unknown> | null): Record<string, unknown> {
  if (!packet) return {};
  return {
    failure: packet.failure,
    knownProgress: packet.knownProgress,
    workspaceDelta: packet.workspaceDelta,
    confirmedCompleted: packet.confirmedCompleted,
    unknownItems: packet.unknownItems,
  };
}
