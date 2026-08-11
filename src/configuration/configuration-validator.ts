import { ZodError } from 'zod';
import { AnyFusionConfigurationV2Schema } from './schema.js';
import type { AnyFusionConfigurationV2 } from './types.js';

export interface ConfigurationValidationIssue {
  path: string;
  code: string;
  message: string;
}

export type ConfigurationValidationResult =
  | { ok: true; config: AnyFusionConfigurationV2 }
  | { ok: false; issues: ConfigurationValidationIssue[] };

export function validateConfigurationCandidate(input: unknown): ConfigurationValidationResult {
  try {
    return {
      ok: true,
      config: AnyFusionConfigurationV2Schema.parse(input),
    };
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    return {
      ok: false,
      issues: error.issues.map(issue => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      })),
    };
  }
}
