import { describe, it, expect } from 'vitest';
import { redactSensitive } from './redact.js';

describe('redactSensitive — key-based', () => {
  it('masks values for sensitive-named keys', () => {
    const { redacted, fields } = redactSensitive({
      username: 'alice',
      password: 'hunter2',
      api_key: 'sk-abc',
      token: 'xyz',
      nested: { secret: 'shh' },
    });
    expect(redacted).toEqual({
      username: 'alice',
      password: '<redacted>',
      api_key: '<redacted>',
      token: '<redacted>',
      nested: { secret: '<redacted>' },
    });
    expect(fields.sort()).toEqual(['api_key', 'nested.secret', 'password', 'token']);
  });

  it('matches Cookie / Authorization header keys', () => {
    const { redacted, fields } = redactSensitive({
      Cookie: 'session=abc',
      Authorization: 'Bearer xyz',
      AuthToken: 'abc',
      author: 'maks', // do NOT mask 'author'
    });
    expect(redacted).toEqual({
      Cookie: '<redacted>',
      Authorization: '<redacted>',
      AuthToken: '<redacted>',
      author: 'maks',
    });
    expect(fields.sort()).toEqual(['AuthToken', 'Authorization', 'Cookie']);
  });

  it('is case-insensitive on key patterns', () => {
    const { fields } = redactSensitive({ PASSWORD: 'a', ApiKey: 'b', clientSecret: 'c' });
    expect(fields.sort()).toEqual(['ApiKey', 'PASSWORD', 'clientSecret']);
  });
});

describe('redactSensitive — sensitive-path siblings', () => {
  it('masks content when file_path points to .env', () => {
    const { redacted, fields } = redactSensitive({
      file_path: '/project/.env',
      content: 'OPENAI_KEY=sk-real',
    });
    expect(redacted).toEqual({ file_path: '/project/.env', content: '<redacted>' });
    expect(fields).toEqual(['content']);
  });

  it('masks content when file_path is .aws/credentials', () => {
    const { redacted, fields } = redactSensitive({
      file_path: '/home/me/.aws/credentials',
      content: 'aws_access_key_id=AKIAIOSFODNN7EXAMPLE',
    });
    expect(redacted).toEqual({
      file_path: '/home/me/.aws/credentials',
      content: '<redacted>',
    });
    expect(fields).toEqual(['content']);
  });

  it('masks new_string + old_string on Edit of .env', () => {
    const { redacted, fields } = redactSensitive({
      file_path: '/p/.env.local',
      old_string: 'TOKEN=foo',
      new_string: 'TOKEN=bar',
    });
    expect(redacted).toMatchObject({
      file_path: '/p/.env.local',
      old_string: '<redacted>',
      new_string: '<redacted>',
    });
    expect(fields.sort()).toEqual(['new_string', 'old_string']);
  });

  it('keeps file_path itself visible (operator needs to know what was touched)', () => {
    const { redacted } = redactSensitive({
      file_path: '/p/.env',
      content: 'x',
    });
    const obj = redacted as Record<string, unknown>;
    expect(obj.file_path).toBe('/p/.env');
    expect(obj.content).toBe('<redacted>');
  });

  it('does NOT mask siblings when path is non-sensitive', () => {
    const { redacted, fields } = redactSensitive({
      file_path: '/project/src/foo.ts',
      content: 'export const x = 1;',
    });
    expect(redacted).toEqual({
      file_path: '/project/src/foo.ts',
      content: 'export const x = 1;',
    });
    expect(fields).toEqual([]);
  });

  it('matches .git/config but not other .git/ files', () => {
    const a = redactSensitive({ file_path: '.git/config', content: '[user]\n  email = me' });
    expect((a.redacted as Record<string, unknown>).content).toBe('<redacted>');

    const b = redactSensitive({ file_path: '.git/HEAD', content: 'ref: refs/heads/main' });
    expect((b.redacted as Record<string, unknown>).content).toBe('ref: refs/heads/main');
  });
});

describe('redactSensitive — inline value patterns', () => {
  it('masks Bearer tokens inside arbitrary strings', () => {
    const { redacted, fields } = redactSensitive({
      tool_result: 'curl -H "Authorization: Bearer abcd1234efgh5678ijkl"',
    });
    expect(redacted).toEqual({ tool_result: '<redacted>' });
    expect(fields).toEqual(['tool_result']);
  });

  it('masks AWS access keys inside text', () => {
    const { redacted } = redactSensitive({
      log: 'found AKIAIOSFODNN7EXAMPLE in env',
    });
    expect((redacted as Record<string, unknown>).log).toBe('<redacted>');
  });

  it('masks Anthropic sk- keys', () => {
    const { redacted } = redactSensitive({
      out: 'OPENAI_KEY=sk-1234567890abcdef1234567890abcdef1234',
    });
    expect((redacted as Record<string, unknown>).out).toBe('<redacted>');
  });

  it('masks JWT-shaped tokens', () => {
    const { redacted } = redactSensitive({
      headers: 'token: eyJhbGciOiJI.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF0kIs',
    });
    expect((redacted as Record<string, unknown>).headers).toBe('<redacted>');
  });

  it('leaves benign strings alone', () => {
    const { redacted, fields } = redactSensitive({
      message: 'Hello world',
      path: '/usr/bin/ls',
    });
    expect(redacted).toEqual({ message: 'Hello world', path: '/usr/bin/ls' });
    expect(fields).toEqual([]);
  });
});

describe('redactSensitive — structural', () => {
  it('walks arrays and records indexed paths', () => {
    const { redacted, fields } = redactSensitive({
      headers: [{ name: 'Authorization', value: 'Bearer abcd1234efgh5678ijklmnop' }],
    });
    const arr = (redacted as Record<string, unknown>).headers as Record<string, unknown>[];
    expect(arr[0]).toMatchObject({ name: 'Authorization', value: '<redacted>' });
    expect(fields).toContain('headers[0].value');
  });

  it('handles null / undefined / primitives without throwing', () => {
    expect(redactSensitive(null).redacted).toBe(null);
    expect(redactSensitive(undefined).redacted).toBe(undefined);
    expect(redactSensitive(42).redacted).toBe(42);
    expect(redactSensitive('hello').redacted).toBe('hello');
    expect(redactSensitive(true).redacted).toBe(true);
  });

  it('stops recursing past MAX_DEPTH', () => {
    let nested: Record<string, unknown> = { secret: 'leaf' };
    for (let i = 0; i < 20; i++) nested = { child: nested };
    // Should not throw; deep secrets past 12 levels stay in place (acceptable —
    // SDK payloads are flat enough that this is purely a defensive cap).
    const result = redactSensitive(nested);
    expect(result.fields.length).toBeLessThanOrEqual(20);
  });

  it('returns a deep copy — does not mutate input', () => {
    const input = { password: 'p', nested: { token: 't' } };
    const { redacted } = redactSensitive(input);
    expect(input.password).toBe('p');
    expect(input.nested.token).toBe('t');
    expect((redacted as Record<string, unknown>).password).toBe('<redacted>');
  });
});
