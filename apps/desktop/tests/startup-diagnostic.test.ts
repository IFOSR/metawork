import { expect, it } from 'vitest';
import { startupFailureCode } from '../main/startup-diagnostic.js';

it('reports controlled failure codes without logging unknown exception bodies or credentials', () => {
  expect(startupFailureCode(new Error('Desktop session could not be established'))).toBe('session-exchange-failed');
  expect(startupFailureCode(Object.assign(new Error('secret path'), { code: 'ENOENT' }))).toBe('ENOENT');
  expect(startupFailureCode(new Error('provider api-key=secret'))).toBe('unexpected');
  expect(startupFailureCode({ message: 'secret' })).toBe('unexpected');
});
