import { runImageApi } from './executor/image-api-runner.js';

async function main(): Promise<void> {
  const result = await runImageApi({
    operation: required('METACLAW_IMAGE_OPERATION') === 'editing' ? 'editing' : 'generation',
    workspacePath: required('METACLAW_IMAGE_WORKSPACE_PATH'),
    inputsPath: process.env.METACLAW_INPUTS_PATH?.trim() || undefined,
    attemptId: required('METACLAW_ATTEMPT_ID'),
    subtaskId: required('METACLAW_SUBTASK_ID'),
    baseUrl: required('METACLAW_IMAGE_BASE_URL'),
    apiKey: required('METACLAW_IMAGE_API_KEY'),
    modelId: required('METACLAW_IMAGE_MODEL'),
    prompt: required('METACLAW_IMAGE_PROMPT'),
    onProgress: text => emit({ type: 'status', text }),
  });
  emit({ type: 'result', ...result });
  if (!result.success) process.exitCode = 1;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  emit({ type: 'result', success: false, output: '', error: message });
  process.exitCode = 1;
});
