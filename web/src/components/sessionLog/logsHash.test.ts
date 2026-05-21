import { describe, expect, it } from 'vitest';
import { hashIsLogsFor, logsHashFor, parseLogsRowAnchor } from './logsHash';

describe('logsHashFor', () => {
  it('builds the base hash without a row id', () => {
    expect(logsHashFor('abc')).toBe('#/session/abc/logs');
  });

  it('appends ?row= when a row id is supplied', () => {
    expect(logsHashFor('abc', 'event:42')).toBe('#/session/abc/logs?row=event%3A42');
  });

  it('encodes row ids with special characters', () => {
    expect(logsHashFor('abc', 'mut/ation:7')).toBe('#/session/abc/logs?row=mut%2Fation%3A7');
  });
});

describe('parseLogsRowAnchor', () => {
  it('returns null when there is no ?row=', () => {
    expect(parseLogsRowAnchor('#/session/abc/logs')).toBeNull();
  });

  it('extracts a row id from the query string', () => {
    expect(parseLogsRowAnchor('#/session/abc/logs?row=event%3A42')).toBe('event:42');
  });

  it('returns null for an empty row value', () => {
    expect(parseLogsRowAnchor('#/session/abc/logs?row=')).toBeNull();
  });

  it('returns the first row param when multiple are present', () => {
    expect(parseLogsRowAnchor('#/session/abc/logs?row=event%3A1&row=event%3A2')).toBe('event:1');
  });
});

describe('hashIsLogsFor', () => {
  it('matches the base form', () => {
    expect(hashIsLogsFor('#/session/abc/logs', 'abc')).toBe(true);
  });

  it('matches with a row anchor', () => {
    expect(hashIsLogsFor('#/session/abc/logs?row=event:1', 'abc')).toBe(true);
  });

  it('rejects mismatched session ids', () => {
    expect(hashIsLogsFor('#/session/xyz/logs', 'abc')).toBe(false);
  });

  it('rejects entirely unrelated hashes', () => {
    expect(hashIsLogsFor('#/something-else', 'abc')).toBe(false);
    expect(hashIsLogsFor('', 'abc')).toBe(false);
  });
});
