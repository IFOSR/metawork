import { existsSync, readFileSync } from 'fs';

export function loadEnvFileIfExists(envPath: string, targetEnv: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(readEnvFileIfExists(envPath))) {
    if (targetEnv[key]) {
      continue;
    }
    targetEnv[key] = value;
  }
}

/** Builds a child-process environment with one executor-specific env file taking precedence. */
export function buildEnvFromFile(
  envPath: string | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    ...(envPath ? readEnvFileIfExists(envPath) : {}),
  };
}

export function readEnvFileIfExists(envPath: string): NodeJS.ProcessEnv {
  if (!existsSync(envPath)) {
    return {};
  }

  const values: NodeJS.ProcessEnv = {};
  const content = readFileSync(envPath, 'utf-8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    if (!key) {
      continue;
    }
    values[key] = parseEnvValue(line.slice(separatorIndex + 1).trim());
  }
  return values;
}

function parseEnvValue(rawValue: string): string {
  if (
    (rawValue.startsWith('"') && rawValue.endsWith('"'))
    || (rawValue.startsWith("'") && rawValue.endsWith("'"))
  ) {
    return rawValue.slice(1, -1);
  }
  return rawValue;
}
