import { describe, expect, test } from 'vitest';
import { _buildNewSessionArgs, _buildNewWindowArgs } from './tmux.js';

describe('tmux argv construction', () => {
  test('_buildNewSessionArgs assembles the expected detached form', () => {
    expect(
      _buildNewSessionArgs({
        name: 'cebab-bus-abc123',
        windowName: 'evaluator',
        cwd: '/Users/x/agents/Evaluator',
        command: 'claude',
      }),
    ).toEqual([
      'new-session',
      '-d',
      '-s',
      'cebab-bus-abc123',
      '-n',
      'evaluator',
      '-c',
      '/Users/x/agents/Evaluator',
      'claude',
    ]);
  });

  test('_buildNewSessionArgs injects -e env entries before the command', () => {
    const args = _buildNewSessionArgs({
      name: 's',
      windowName: 'w',
      cwd: '/cwd',
      command: 'claude',
      env: { BUS_AGENT_NAME: 'reviewer', FOO: 'bar' },
    });
    // Command must remain the final element so tmux invokes the right thing.
    expect(args[args.length - 1]).toBe('claude');
    // Both env entries must appear as a -e KEY=VALUE pair.
    expect(args).toEqual(expect.arrayContaining(['-e', 'BUS_AGENT_NAME=reviewer']));
    expect(args).toEqual(expect.arrayContaining(['-e', 'FOO=bar']));
  });

  test('_buildNewWindowArgs targets a session with -t', () => {
    expect(
      _buildNewWindowArgs({
        sessionName: 'cebab-bus-abc123',
        windowName: 'reviewer',
        cwd: '/Users/x/agents/Reviewer',
        command: 'claude',
      }),
    ).toEqual([
      'new-window',
      '-d',
      '-t',
      'cebab-bus-abc123',
      '-n',
      'reviewer',
      '-c',
      '/Users/x/agents/Reviewer',
      'claude',
    ]);
  });
});
