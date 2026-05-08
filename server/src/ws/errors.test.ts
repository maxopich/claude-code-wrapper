import { describe, expect, test } from 'vitest';
import { classifyError } from './errors.js';

describe('classifyError', () => {
  test('typed ENOENT spawn → claude_not_found', () => {
    const err = Object.assign(new Error('spawn claude ENOENT'), {
      code: 'ENOENT',
      syscall: 'spawn claude',
    });
    expect(classifyError(err).kind).toBe('claude_not_found');
  });

  test('AbortError (instance shape) → process_crashed', () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(classifyError(err).kind).toBe('process_crashed');
  });

  test('rate-limit phrasing → rate_limited', () => {
    expect(classifyError(new Error('Rate-limit exceeded for 5h')).kind).toBe('rate_limited');
    expect(classifyError(new Error('You are rate limited')).kind).toBe('rate_limited');
  });

  test('auth-expired phrasing → auth_expired', () => {
    expect(classifyError(new Error('Please log in to continue')).kind).toBe('auth_expired');
    expect(classifyError(new Error('OAuth token expired')).kind).toBe('auth_expired');
  });

  test('JSON parse errors land in parse_error, not generic process_crashed', () => {
    expect(classifyError(new Error('JSON.parse: unexpected token')).kind).toBe('parse_error');
    expect(classifyError(new Error('Unexpected token < in JSON at position 0')).kind).toBe(
      'parse_error',
    );
  });

  test('messages that just mention "json" no longer false-match parse_error', () => {
    // Tightened regex was the whole point — used to be /parse|json/i which matched any
    // SDK validation error that happened to mention json.
    expect(classifyError(new Error('Invalid options: tools must be json-serializable')).kind).toBe(
      'process_crashed',
    );
  });

  test('unknown errors fall through to process_crashed', () => {
    expect(classifyError(new Error('something exploded')).kind).toBe('process_crashed');
    expect(classifyError('plain string').kind).toBe('process_crashed');
  });
});
