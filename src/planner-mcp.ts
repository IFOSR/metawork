import { runPlannerMcpServer } from './planning/planner-mcp-server.js';

runPlannerMcpServer().catch((error) => {
  process.stderr.write(`planner-mcp: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
