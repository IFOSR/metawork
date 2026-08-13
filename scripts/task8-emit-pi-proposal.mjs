import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [piRoot, schemaPath, proposalPath, socketPath] = process.argv.slice(2);
if (!piRoot || !schemaPath || !proposalPath || !socketPath) {
  throw new Error('usage: task8-emit-pi-proposal.mjs <pi-root> <schema> <proposal> <socket>');
}

const requireFromPi = createRequire(join(piRoot, 'package.json'));
const valueModulePath = requireFromPi.resolve('typebox/value');
const [{ createPlanningProposalTool }, { Value }] = await Promise.all([
  import(pathToFileURL(join(
    piRoot,
    'packages/coding-agent/src/anyfusion/planner-proposal-tool.ts',
  )).href),
  import(pathToFileURL(valueModulePath).href),
]);
const proposal = JSON.parse(await readFile(proposalPath, 'utf8'));
const tool = createPlanningProposalTool(schemaPath);
const params = { plan: proposal };
if (!Value.Check(tool.parameters, params)) {
  const issues = [...Value.Errors(tool.parameters, params)]
    .map(issue => `${issue.path || 'params'}: ${issue.message}`);
  throw new Error(`AnyFusion-Pi rejected the generated schema fixture: ${issues.join('; ')}`);
}

process.env.ANYFUSION_BRIDGE_SOCKET = socketPath;
process.env.ANYFUSION_PLANNER_SESSION_ID = 'session_task8_contract';
process.env.ANYFUSION_PLANNER_TURN_PURPOSE = 'kernel';
process.env.ANYFUSION_PLANNER_RUNTIME_VERSION = 'task8-contract-acceptance';

const result = await tool.execute('call_task8_contract', params, undefined, undefined, {
  mode: 'rpc',
  sessionManager: {
    getBranch: () => [{
      type: 'message',
      id: 'task8-contract-user',
      parentId: null,
      timestamp: '2026-08-12T00:00:00.000Z',
      message: {
        role: 'user',
        content: [{
          type: 'text',
          text: 'Verify the pinned Planner v8 and Work Graph v7 contract.',
        }],
        timestamp: Date.parse('2026-08-12T00:00:00.000Z'),
      },
    }],
  },
});

process.stdout.write(`${JSON.stringify({
  schemaAcceptedByPi: true,
  result: result.details,
  terminated: result.terminate,
})}\n`, () => process.exit(0));
