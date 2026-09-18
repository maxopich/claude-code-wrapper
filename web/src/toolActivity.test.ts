import { describe, expect, test } from 'vitest';
import { toolActivity, toolActivityText } from './toolActivity';

/**
 * `Cebab-ibb4`: the live status line's label.
 *
 * The case that carries the design is `two deep files do not read the same` —
 * a path clipped from the head produces the identical string for every file in
 * the project, which is the one outcome a status line cannot have and the exact
 * bug a `clipHead` applied uniformly would introduce. The rest is a table.
 */

const say = (name: string, input?: unknown) => toolActivityText(toolActivity(name, input));

describe('toolActivity — the subject is the point', () => {
  test('a file is named by its TAIL, so files in sibling packages differ', () => {
    // Clipping from the head gives `/Users/x/Claude_Spa…` for every file in the
    // project — one label for all of them. Two trailing segments is not enough
    // either: this repo has `store.ts` under two packages.
    const web = say('Read', { file_path: '/Users/x/Claude_Space/Cebab/web/src/store.ts' });
    const server = say('Read', { file_path: '/Users/x/Claude_Space/Cebab/server/src/store.ts' });
    expect(web).toBe('reading web/src/store.ts');
    expect(server).toBe('reading server/src/store.ts');
    expect(web).not.toBe(server);
  });

  test('a path too long for three segments still ends in the basename', () => {
    const deep = say('Read', { file_path: `/${'segment/'.repeat(12)}the-one-I-want.ts` });
    expect(deep.endsWith('the-one-I-want.ts')).toBe(true);
    expect(deep.length).toBeLessThan(70);
  });

  test('a bare filename is itself, not a fragment of one', () => {
    expect(say('Read', { file_path: 'README.md' })).toBe('reading README.md');
  });

  test('a shell command is the command, not the model’s description of it', () => {
    expect(say('Bash', { command: 'npm test', description: 'Run the test suite' })).toBe(
      'running npm test',
    );
  });

  test('a long command is clipped but still recognisable at its head', () => {
    const label = say('Bash', { command: `git log --oneline ${'-x '.repeat(60)}` });
    expect(label.startsWith('running git log --oneline')).toBe(true);
    expect(label.length).toBeLessThan(70);
  });

  test('an MCP tool names the tool and its server, never a JSON peek', () => {
    // The arm that matters most for an operator with servers installed:
    // `classifyToolCall` sends every `mcp__*` call to its default arm and
    // returns `mcp__x__y: {"…` — which is why this table exists at all.
    expect(say('mcp__linear__search_issues', { query: 'x' })).toBe('calling search_issues linear');
    // The split is at the SECOND separator: a tool name may carry `__`.
    expect(say('mcp__srv__a__b', {})).toBe('calling a__b srv');
  });

  test('the searches say what they are searching for', () => {
    expect(say('Grep', { pattern: 'classifyToolCall' })).toBe('searching for classifyToolCall');
    expect(say('WebFetch', { url: 'https://docs.example.com/a/b?c=d' })).toBe(
      'reading docs.example.com',
    );
  });

  test('an unknown tool degrades to its own name, never to a wrong answer', () => {
    expect(say('SomeFutureTool', { a: 1 })).toBe('running SomeFutureTool');
  });

  test('a tool with no input still names the action', () => {
    // The multi-agent activity bar has a tool name from a bus event and no
    // input at all.
    expect(say('Read')).toBe('reading');
    expect(say('Bash')).toBe('running a command');
    expect(say('')).toBe('running a tool');
  });
});

describe('toolActivity — model-written text cannot break the line', () => {
  test('newlines and tabs collapse to single spaces', () => {
    expect(say('Bash', { command: 'echo one\n\nrm -rf /\ttwo' })).toBe(
      'running echo one rm -rf / two',
    );
  });

  test('the invisible format characters go too, not just whitespace', () => {
    // `\p{Cf}` is the half that survives every naive escape: U+2028 is a line
    // terminator `JSON.stringify` leaves raw, and U+202E reverses the reading
    // order of everything after it. Both are model-controlled here — the path
    // comes from the tool call.
    //
    // ASSEMBLED AT RUNTIME, and it has to be: written as `\u2028` escapes,
    // prettier rewrites them to the literal codepoints on the next `--write`,
    // and a raw U+2028 inside a regex literal is a line terminator the parser
    // refuses — this file failed to compile exactly once for that reason.
    const LINE_SEP = String.fromCodePoint(0x2028);
    const RTL_OVERRIDE = String.fromCodePoint(0x202e);
    const label = say('Read', { file_path: `src/a${LINE_SEP}b${RTL_OVERRIDE}c.ts` });
    expect(label).not.toContain(LINE_SEP);
    expect(label).not.toContain(RTL_OVERRIDE);
    // `src` survives as a segment because flattening runs BEFORE the split —
    // the injected terminators became spaces inside one segment, not new ones.
    expect(label).toBe('reading src/a b c.ts');
  });

  test('CONTROL: an ordinary label is not being mangled by the same pass', () => {
    // Without this, a `flatten` that returned '' would satisfy both cases
    // above.
    expect(say('Read', { file_path: 'web/src/store.ts' })).toBe('reading web/src/store.ts');
  });
});
