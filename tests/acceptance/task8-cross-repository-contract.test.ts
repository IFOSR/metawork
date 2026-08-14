import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { buildStagedLegacyConfiguration } from '../../src/configuration/staged-legacy-configuration.js';
import { ControlKernel, type KernelEvent, type KernelSnapshot } from '../../src/kernel/control-kernel.js';
import { PlanningAgentPlanOutputSchema } from '../../src/planning/planning-agent-plan-schema.js';
import { validatePlanningAgentPlan } from '../../src/planning/planning-agent-plan-validator.js';
import {
  ANYFUSION_PLANNER_HOST_PROTOCOL_VERSION,
  isPlannerHostRequest,
} from '../../src/tui-bridge/planner-host-protocol.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = join(
  repositoryRoot,
  'tests/fixtures/task8-cross-repository-contract.json',
);
const proposalPath = join(
  repositoryRoot,
  'tests/fixtures/task8-anyfusion-pi-proposal.json',
);
const driverPath = join(repositoryRoot, 'scripts/task8-emit-pi-proposal.mjs');
const cleanupPaths: string[] = [];

interface ContractManifest {
  schemaVersion: 1;
  metawork: { contractCommit: string };
  anyFusionPi: { commit: string };
  hostProtocolVersion: number;
  planningAgentPlanVersion: number;
  workGraphVersion: number;
  planningAgentPlanSchemaSha256: string;
}

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    try {
      execFileSync('rm', ['-f', path]);
    } catch {
      // The OS may already have removed a closed Unix socket.
    }
  }
});

describe('Task 8 cross-repository planning contract', () => {
  it('pins Pi emission through the MetaWork validator and ControlKernel admission', async () => {
    const manifest = readJson<ContractManifest>(manifestPath);
    const proposal = readJson<Record<string, unknown>>(proposalPath);
    const piRoot = findPinnedPiCheckout(manifest.anyFusionPi.commit);

    expect(manifest.schemaVersion).toBe(1);
    expect(ANYFUSION_PLANNER_HOST_PROTOCOL_VERSION).toBe(manifest.hostProtocolVersion);
    expect(proposal.schemaVersion).toBe(manifest.planningAgentPlanVersion);
    expect((proposal.workGraph as { schemaVersion?: unknown }).schemaVersion)
      .toBe(manifest.workGraphVersion);
    expect(isAncestor(repositoryRoot, manifest.metawork.contractCommit)).toBe(true);
    expect(git(piRoot, ['rev-parse', 'HEAD'])).toBe(manifest.anyFusionPi.commit);

    const schemaText = generatePlannerSchema();
    expect(sha256(schemaText)).toBe(manifest.planningAgentPlanSchemaSha256);
    const suffix = `${process.pid}-${Date.now()}`;
    const schemaPath = join(tmpdir(), `task8-planner-v8-${suffix}.schema.json`);
    const socketPath = join(tmpdir(), `task8-planner-host-${suffix}.sock`);
    cleanupPaths.push(schemaPath, socketPath);
    writeFileSync(schemaPath, schemaText, 'utf8');

    const staged = buildStagedLegacyConfiguration({ testMode: true });
    let admittedDecision: ReturnType<ControlKernel['decide']> | null = null;
    let capturedRequest: Record<string, unknown> | null = null;
    const server = createServer(socket => {
      handlePlannerConnection(socket, request => {
        capturedRequest = request;
        const plan = request.plan;
        const validation = validatePlanningAgentPlan(plan, staged.planner);
        if (!validation.valid) {
          return {
            status: 'rejected',
            turnId: request.turnId,
            submissionId: request.submissionId,
            planId: null,
            rejectionType: 'validation',
            issues: validation.errors,
            kernel: null,
          };
        }

        admittedDecision = new ControlKernel().decide(
          planEvent(plan as KernelEvent['proposal'], staged.planner.revisionId),
          admissionSnapshot(staged),
        );
        if (admittedDecision.action.type !== 'authorize_task_plan') {
          return {
            status: 'rejected',
            turnId: request.turnId,
            submissionId: request.submissionId,
            planId: (plan as { id?: string }).id ?? null,
            rejectionType: 'kernel',
            issues: [admittedDecision.reason],
            kernel: {
              decisionId: admittedDecision.id,
              action: 'reject_request',
              reason: admittedDecision.reason,
            },
          };
        }
        return {
          status: 'accepted',
          turnId: request.turnId,
          submissionId: request.submissionId,
          planId: (plan as { id: string }).id,
          outcome: 'task_authorized',
          displayText: 'Task 8 cross-repository contract authorized',
          taskId: admittedDecision.action.taskId,
          kernel: {
            decisionId: admittedDecision.id,
            action: admittedDecision.action.type,
            reason: admittedDecision.reason,
          },
        };
      });
    });

    server.listen(socketPath);
    await once(server, 'listening');
    try {
      const driverResult = await runPiDriver(piRoot, schemaPath, socketPath);
      expect(driverResult).toMatchObject({
        schemaAcceptedByPi: true,
        terminated: true,
        result: {
          status: 'accepted',
          planId: proposal.id,
          outcome: 'task_authorized',
        },
      });
    } finally {
      server.close();
      await once(server, 'close');
    }

    expect(capturedRequest).toMatchObject({
      protocolVersion: manifest.hostProtocolVersion,
      type: 'proposal_submit',
      sessionId: 'session_task8_contract',
      purpose: 'kernel',
      plan: proposal,
    });
    expect(admittedDecision).toMatchObject({
      schemaVersion: 5,
      configurationRevision: 'revision-test',
      action: {
        type: 'authorize_task_plan',
        workGraph: {
          schemaVersion: manifest.workGraphVersion,
          configurationRevision: 'revision-test',
        },
        authorizedBindingsBySubtask: {
          verify_contract: [{
            agentClassRef: 'codex-cli',
            harnessRef: 'codex-cli',
            providerRef: 'test-provider',
            modelRef: 'test-model',
            permissionProfileRef: 'workspace-engineering',
            configurationRevision: 'revision-test',
          }],
        },
      },
    });
  }, 90_000);
});

function generatePlannerSchema(): string {
  const schema = z.toJSONSchema(PlanningAgentPlanOutputSchema, {
    target: 'draft-7',
    unrepresentable: 'any',
  });
  return `${JSON.stringify(schema, null, 2)}\n`;
}

function planEvent(
  proposal: KernelEvent['proposal'],
  configurationRevision: string,
): Extract<KernelEvent, { type: 'plan_proposed' }> {
  return {
    schemaVersion: 5,
    configurationRevision,
    type: 'plan_proposed',
    id: 'event_task8_contract',
    correlationId: 'request_task8_contract',
    causationId: null,
    occurredAt: '2026-08-12T00:00:00.000Z',
    sessionId: 'session_task8_contract',
    requestText: 'Verify the pinned Planner v8 and Work Graph v7 contract.',
    generationId: 'generation_task8_contract',
    proposalSource: 'initial',
    targetGraphRevision: 1,
    proposal,
  };
}

function admissionSnapshot(
  staged: ReturnType<typeof buildStagedLegacyConfiguration>,
): Extract<KernelSnapshot, { type: 'plan_admission' }> {
  return {
    schemaVersion: 5,
    type: 'plan_admission',
    tasks: [],
    runningTaskId: null,
    plannerConfiguration: staged.planner,
    kernelConfiguration: staged.kernel,
    executorStatuses: [],
    v5WorkGraphTaskIds: [],
    eligibleContextRefKeys: ['current_user_input'],
    pendingAuthorizationRequest: null,
  };
}

function handlePlannerConnection(
  socket: Socket,
  onProposal: (request: Record<string, any>) => Record<string, unknown>,
): void {
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const request = JSON.parse(line) as Record<string, any>;
      if (!isPlannerHostRequest(request)) {
        socket.write(`${JSON.stringify({
          protocolVersion: ANYFUSION_PLANNER_HOST_PROTOCOL_VERSION,
          type: 'error',
          requestId: typeof request.requestId === 'string' ? request.requestId : null,
          error: { code: 'invalid_request', message: 'invalid Planner Host request' },
        })}\n`);
      } else if (request.type === 'hello') {
        socket.write(`${JSON.stringify({
          protocolVersion: ANYFUSION_PLANNER_HOST_PROTOCOL_VERSION,
          type: 'hello',
          requestId: request.requestId,
          accepted: true,
          capabilities: ['proposal_submit'],
        })}\n`);
      } else if (request.type === 'proposal_submit') {
        socket.write(`${JSON.stringify({
          protocolVersion: ANYFUSION_PLANNER_HOST_PROTOCOL_VERSION,
          type: 'proposal_result',
          requestId: request.requestId,
          result: onProposal(request),
        })}\n`);
      }
      newline = buffer.indexOf('\n');
    }
  });
}

async function runPiDriver(
  piRoot: string,
  schemaPath: string,
  socketPath: string,
): Promise<Record<string, unknown>> {
  const executable = join(piRoot, 'node_modules/.bin/tsx');
  const stdout = await new Promise<string>((resolvePromise, reject) => {
    execFile(
      executable,
      [driverPath, piRoot, schemaPath, proposalPath, socketPath],
      { cwd: piRoot, timeout: 60_000 },
      (error, output, stderr) => {
        if (error) {
          reject(new Error(`AnyFusion-Pi proposal driver failed: ${stderr || error.message}`));
          return;
        }
        resolvePromise(output.trim());
      },
    );
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

function findPinnedPiCheckout(expectedCommit: string): string {
  const candidates = [
    process.env.ANYFUSION_PI_WORKTREE,
    resolve(repositoryRoot, '../anyfusion-pi-server-upgrade'),
    resolve(repositoryRoot, '../AnyFusion-Pi'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const inspected = candidates.map(candidate => {
    try {
      return { candidate, head: git(candidate, ['rev-parse', 'HEAD']) };
    } catch {
      return { candidate, head: 'unavailable' };
    }
  });
  const match = inspected.find(candidate => candidate.head === expectedCommit);
  if (match) return match.candidate;
  throw new Error(
    `AnyFusion-Pi checkout at ${expectedCommit} is required; inspected ${inspected
      .map(candidate => `${candidate.candidate} (${candidate.head})`)
      .join(', ')}`,
  );
}

function isAncestor(repository: string, commit: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], {
      cwd: repository,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function git(repository: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
  }).trim();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
