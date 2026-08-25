import { describe, it, expect } from 'vitest';
import { redactSensitive, isSensitiveKey, ROOT_FIELD } from './redact.js';

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
      tool_result: 'curl -H "Authorization: Bearer abcd1234efgh5678ijkl"', // synthetic; allowlisted by literal in .gitleaks.toml
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
      out: 'OPENAI_KEY=sk-1234567890abcdef1234567890abcdef1234', // synthetic; allowlisted by literal in .gitleaks.toml
    });
    expect((redacted as Record<string, unknown>).out).toBe('<redacted>');
  });

  it('masks JWT-shaped tokens', () => {
    const { redacted } = redactSensitive({
      headers: 'token: eyJhbGciOiJI.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF0kIs', // synthetic; allowlisted by literal in .gitleaks.toml
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

  it('[security] masks past MAX_DEPTH instead of passing the subtree through', () => {
    // Register D24. This case used to assert `fields.length <= 20` with a
    // comment calling the leak "acceptable — SDK payloads are flat enough
    // that this is purely a defensive cap". Both halves were wrong: `walk`
    // returned the CALLER'S OWN object by reference, so the cap did not just
    // stop masking, it aliased; and the assertion passed on essentially any
    // behaviour.
    let nested: Record<string, unknown> = { leaf: 'AKIAIOSFODNN7EXAMPLE' };
    for (let i = 0; i < 20; i++) nested = { child: nested };

    const { redacted, fields } = redactSensitive(nested);

    // Walk down to the cut-off and assert we hit the token, not an object.
    let cursor: unknown = redacted;
    let depth = 0;
    while (cursor && typeof cursor === 'object' && 'child' in (cursor as object)) {
      cursor = (cursor as Record<string, unknown>).child;
      depth += 1;
      if (depth > 30) break;
    }
    expect(cursor).toBe('<redacted>');
    // And it SAID so — the whole point of D24/D25 is that masking silently is
    // half a bug.
    expect(fields.length).toBeGreaterThan(0);
  });

  it('[security] the over-depth cut never hands back the input object', () => {
    // The aliasing half, isolated. Mutating the returned subtree must not
    // reach the caller's object — the JSDoc promises a deep clone.
    const deepLeaf: Record<string, unknown> = { marker: 'original' };
    let nested: Record<string, unknown> = deepLeaf;
    for (let i = 0; i < 20; i++) nested = { child: nested };

    const { redacted } = redactSensitive(nested);
    // Reach the deepest surviving node and confirm nothing in the output
    // graph is the very object we passed in.
    const seen = new Set<unknown>();
    const stack: unknown[] = [redacted];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      for (const v of Object.values(node as Record<string, unknown>)) stack.push(v);
    }
    expect(seen.has(deepLeaf)).toBe(false);
  });

  it('returns a deep copy — does not mutate input', () => {
    const input = { password: 'p', nested: { token: 't' } };
    const { redacted } = redactSensitive(input);
    expect(input.password).toBe('p');
    expect(input.nested.token).toBe('t');
    expect((redacted as Record<string, unknown>).password).toBe('<redacted>');
  });
});

// Register D24/D25 [security]. Both are the same defect seen from opposite
// sides: the redactor's `fields` list is how every caller answers "did this
// payload contain a secret?", and it was wrong in both directions — a masked
// root reported nothing, and an over-depth subtree was neither masked nor
// reported. Five call sites gate on exactly that
// (`if (fields.length > 0) row.redactedFields = fields`).
describe('redactSensitive — the report matches the masking [security]', () => {
  it('a top-level string that IS a credential reports one field', () => {
    const { redacted, fields } = redactSensitive('AKIAIOSFODNN7EXAMPLE');
    // Both halves together: asserting the field count alone would pass if
    // the value quietly stopped being masked at all.
    expect(redacted).toBe('<redacted>');
    expect(fields).toEqual([ROOT_FIELD]);
  });

  it('a top-level string that is NOT a credential still reports nothing', () => {
    // The negative control for the case above — the sentinel must not fire
    // on ordinary text, or every caller starts showing a redaction badge.
    const { redacted, fields } = redactSensitive('just some prose about tokens');
    expect(redacted).toBe('just some prose about tokens');
    expect(fields).toEqual([]);
  });

  it('the sentinel is not a reachable dot-path, so it cannot collide', () => {
    // `(root)` is deliberately not a valid key path. If a payload could
    // produce it naturally, a caller could not tell "the root was masked"
    // from "a field called (root) was masked".
    const { fields } = redactSensitive({ password: 'x' });
    expect(fields).toEqual(['password']);
    expect(fields).not.toContain(ROOT_FIELD);
  });
});

// Register D05 [security]. Under a sensitive key only `string | number` was
// masked; objects and arrays were copied through VERBATIM — while the same
// branch pushed the path onto `fields`, attesting that it had been redacted.
// A leak plus a false attestation, and `redactSensitive` is what
// `session_log_export` runs over every line of an exported transcript, so it
// sits on the path by which data leaves the machine.
//
// The contract now: a sensitive key masks its value WHOLESALE, whatever the
// type. Every path in `fields` corresponds to something actually masked.
describe('redactSensitive — non-scalar values under a sensitive key [security]', () => {
  it('masks an object under a sensitive key instead of passing it through', () => {
    const { redacted, fields } = redactSensitive({ credentials: { password: 'hunter2' } });
    expect(redacted).toEqual({ credentials: '<redacted>' });
    expect(fields).toEqual(['credentials']);
    // The regression in one line: the secret must not survive anywhere.
    expect(JSON.stringify(redacted)).not.toContain('hunter2');
  });

  it('masks an array under a sensitive key', () => {
    const { redacted } = redactSensitive({ tokens: ['sk-aaa', 'sk-bbb'] });
    expect(redacted).toEqual({ tokens: '<redacted>' });
    expect(JSON.stringify(redacted)).not.toContain('sk-aaa');
  });

  it('masks a deeply structured credential blob', () => {
    const { redacted } = redactSensitive({
      user: 'alice',
      secret: { aws: { access_key: 'AKIAIOSFODNN7EXAMPLE', nested: ['deep-secret'] } },
    });
    expect(redacted).toEqual({ user: 'alice', secret: '<redacted>' });
    expect(JSON.stringify(redacted)).not.toContain('deep-secret');
    expect(JSON.stringify(redacted)).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('every reported field really was masked — no false attestation', () => {
    const { redacted, fields } = redactSensitive({
      apiKey: { primary: 'sk-1', backup: 'sk-2' },
      authorization: ['Bearer a'],
      harmless: { a: 1 },
    });
    const blob = redacted as Record<string, unknown>;
    for (const f of fields) {
      // Only top-level paths here; that is the shape a wholesale mask produces.
      expect(blob[f]).toBe('<redacted>');
    }
    expect(fields.sort()).toEqual(['apiKey', 'authorization']);
    expect(blob.harmless).toEqual({ a: 1 });
  });

  it('masks past MAX_DEPTH — the reason this is wholesale, not recursive', () => {
    // `walk` returns values verbatim past MAX_DEPTH (12). Recursing into a
    // sensitive key would therefore still leak anything nested deeper than
    // that, while continuing to report the field as masked. Masking the whole
    // subtree in one step is depth-independent, so this holds at any nesting.
    let deep: Record<string, unknown> = { leaf: 'deep-secret' };
    for (let i = 0; i < 30; i++) deep = { child: deep };
    const { redacted } = redactSensitive({ password: deep });
    expect(redacted).toEqual({ password: '<redacted>' });
    expect(JSON.stringify(redacted)).not.toContain('deep-secret');
  });

  it('still recurses normally under a NON-sensitive key', () => {
    // The fix must not turn into "mask any object" — ordinary structure has to
    // keep its shape so the Logs view stays readable.
    const { redacted, fields } = redactSensitive({
      request: { url: 'https://example.test', headers: { token: 'abc' } },
    });
    expect(redacted).toEqual({
      request: { url: 'https://example.test', headers: { token: '<redacted>' } },
    });
    expect(fields).toEqual(['request.headers.token']);
  });

  it('null and undefined under a sensitive key mask to the token', () => {
    // Previously these fell into the `: raw` branch and passed through as
    // null/undefined while being reported as redacted. Harmless in itself, but
    // the attestation should not be able to disagree with the value.
    const { redacted } = redactSensitive({ password: null, secret: undefined });
    expect(redacted).toEqual({ password: '<redacted>', secret: '<redacted>' });
  });
});

/**
 * Register H05. `isSensitiveKey` was module-private; it is exported now
 * because `repo/project_authority.ts`'s `detectEnvInjections` uses the SAME
 * judgement to decide whether an env key declared in a project's
 * settings.json should park the session-start gate. One list means a name
 * masked in a transcript is a name prompted for before it reaches an agent's
 * environment — rather than two heuristics drifting apart.
 */
describe('isSensitiveKey — shared with the env-injection gate (H05)', () => {
  it.each([
    'password',
    'PASSWD',
    'client_secret',
    'GITHUB_TOKEN',
    'apiKey',
    'API_KEY',
    'AWS_ACCESS_KEY_ID',
    'PRIVATE_KEY',
    'Authorization',
    'auth_token',
    'BEARER',
    'credentials',
    'cookie',
    'session_id',
  ])('%s is credential-shaped', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(['NODE_ENV', 'PORT', 'HOME', 'LANG', 'author', 'AUTHOR_NAME', 'path'])(
    '%s is not',
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );

  it('the author / authorization boundary the pattern deliberately encodes', () => {
    // `/auth(?:orization)?(?!or)/i` exists to catch 'auth' and 'authorization'
    // while sparing 'author'. Asserted directly now that the function is part
    // of the API surface, because a regex tweak here silently changes which
    // env keys prompt the operator.
    expect(isSensitiveKey('author')).toBe(false);
    expect(isSensitiveKey('authorization')).toBe(true);
    expect(isSensitiveKey('auth')).toBe(true);
  });
});

// Register H16 [security]. The value-pattern list was five entries — an
// authorization header, `bearer`, AWS `AKIA`, `sk-`, and a JWT shape. No
// private key, and none of the vendor prefixes that dominate real leaks. The
// basename list covered dotfiles and `id_rsa` but no key-file extension.
//
// Every positive case below is paired with a NEGATIVE one. A pattern test
// passes on any string the regex happens to hit, so "it masked the token" is
// only half the claim — the other half is that ordinary prose, and the PUBLIC
// halves of the same primitives, survive untouched.
describe('redactSensitive — credential shapes [security]', () => {
  const masked = (v: string) => redactSensitive({ note: v }).redacted as Record<string, unknown>;

  it('masks a PEM private key header, whatever the algorithm', () => {
    for (const algo of ['RSA ', 'EC ', 'DSA ', 'OPENSSH ', 'ENCRYPTED ', '']) {
      const body = `-----BEGIN ${algo}PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END-----`;
      expect(masked(body).note, `algo=${algo || '(none)'}`).toBe('<redacted>');
    }
  });

  it('does NOT mask a public key or a certificate', () => {
    // These exist to be handed out. Masking them protects nothing and costs
    // the operator the answer to "which cert is this run using?".
    expect(masked('-----BEGIN PUBLIC KEY-----\nMIIBIjAN\n-----END-----').note).toContain(
      'BEGIN PUBLIC KEY',
    );
    expect(masked('-----BEGIN CERTIFICATE-----\nMIIDXTCC\n-----END-----').note).toContain(
      'BEGIN CERTIFICATE',
    );
  });

  // The token literals never appear in this file. Each is assembled at
  // RUNTIME from a prefix and filler, because gitleaks scans text: a split
  // literal cannot match its ruleset, so the repo's secret scan keeps full
  // strength instead of `.gitleaks.toml` growing ten by-value exemptions for
  // strings that are synthetic by construction. (Checked, not assumed —
  // written as literals first, these tripped 8 findings across
  // github-pat / github-oauth / gcp-api-key / npm-access-token /
  // stripe-access-token / generic-api-key.)
  //
  // The redactor sees the assembled value, so what is under test is
  // unchanged; only the on-disk representation differs.
  const FILLER = 'A1b2C3d4E5f6G7h8J9k0';
  const synth = (prefix: string, len = 36): string => prefix + FILLER.repeat(4).slice(0, len);

  it.each([
    ['GitHub PAT', () => synth('ghp_')],
    ['GitHub OAuth', () => synth('gho_')],
    ['GitHub fine-grained', () => synth('github_pat_', 40)],
    ['GitLab PAT', () => synth('glpat-', 20)],
    ['Slack bot token', () => synth('xoxb-', 24)],
    ['Google API key', () => synth('AIza', 35)],
    ['npm token', () => synth('npm_', 36)],
    ['Stripe live secret', () => synth('sk_live_', 24)],
    ['Stripe restricted', () => synth('rk_live_', 24)],
  ])('masks a %s', (_label, build) => {
    const token = build();
    expect(masked(`the value is ${token} ok`).note).toBe('<redacted>');
  });

  it.each([
    ['the bare prefix with no token body', () => 'ghp_'],
    ['prose mentioning a vendor', () => 'see the GitLab glpat docs for rotation'],
    ['a word that merely starts with AIza', () => 'AIzaBrand'],
    // Stripe TEST keys are publishable by design — masking them costs an
    // operator real debugging signal and protects nothing.
    ['a Stripe test key', () => synth('sk_test_', 24)],
  ])('does NOT mask %s', (_label, build) => {
    const text = build();
    expect(masked(text).note).toBe(text);
  });

  it.each(['server.pem', 'tls.key', 'bundle.p12', 'store.pfx', 'keys.jks', 'app.keystore'])(
    'treats %s as a sensitive path, masking the sibling content',
    (name) => {
      const out = redactSensitive({ file_path: `/srv/certs/${name}`, content: 'key material' })
        .redacted as Record<string, unknown>;
      expect(out.content).toBe('<redacted>');
      // The path itself stays readable — it is what tells the operator WHICH
      // file was touched.
      expect(out.file_path).toBe(`/srv/certs/${name}`);
    },
  );

  it('matches key extensions case-insensitively, which matters on Windows', () => {
    const out = redactSensitive({ file_path: 'C:\\certs\\SERVER.PEM', content: 'k' })
      .redacted as Record<string, unknown>;
    expect(out.content).toBe('<redacted>');
  });

  it('does NOT treat a public cert extension as sensitive', () => {
    const out = redactSensitive({ file_path: '/srv/certs/server.crt', content: 'cert body' })
      .redacted as Record<string, unknown>;
    expect(out.content).toBe('cert body');
  });
});

/**
 * [security] Register of0 — the files THIS REPO documents as credential-bearing.
 *
 * The class of bug: the docs knew and the list did not. CLAUDE.md's
 * env-precedence caveat, its MCP section, and README's "local data" section each
 * name a file that holds credentials; none of them was on the path list, so a
 * `Read` of one shipped its body to the Logs surface and into every export.
 *
 * The audit table below IS the record the acceptance criteria asked for: every
 * documented file is either a positive here, or a named negative carrying the
 * reason it is not covered.
 */
describe('[security] Cebab-documented credential files (of0)', () => {
  /** Does a sensitive path on this object mask its sibling body? */
  const masksBody = (filePath: string): boolean =>
    (redactSensitive({ filePath, content: 'BODY' }).redacted as Record<string, unknown>).content ===
    '<redacted>';

  it.each([
    // The reported case, in all three forms an operator can produce.
    ['.mcp.json — relative, as a project-root read reports it', '.mcp.json'],
    ['.mcp.json — absolute', '/home/u/proj/.mcp.json'],
    ['.mcp.json — Windows, the operator platform', 'C:\\proj\\.mcp.json'],
    ['a .mcp.json backup', '.mcp.json.bak'],
    // CLAUDE.md: top-level `mcpServers` blocks carry `env`, and Trust does not
    // scope them.
    ['~/.claude.json', '/home/u/.claude.json'],
    ['the CLI backup of it', '/home/u/.claude.json.backup'],
    // README names this as where the OAuth credentials live. Uncovered until
    // of0 because the stem matcher could not see past the leading dot.
    ['~/.claude/.credentials.json', '/home/u/.claude/.credentials.json'],
    // Both halves of the settings pair — see the SENSITIVE_TAILS comment.
    ['.claude/settings.json', '.claude/settings.json'],
    ['.claude/settings.local.json', '.claude/settings.local.json'],
    ['the user-scope settings file', '/home/u/.claude/settings.json'],
  ])('masks the body of %s', (_label, filePath) => {
    expect(masksBody(filePath)).toBe(true);
  });

  // Regression controls. These passed BEFORE of0 and must still pass: the
  // matcher change touches every stem, so a fix that widened coverage by
  // breaking `.env` would otherwise look like a clean win.
  it.each([
    '.env',
    '.env.local',
    '/home/u/.aws/credentials',
    '/home/u/.ssh/id_rsa',
    '/srv/certs/server.pem',
    '/home/u/.npmrc',
    '/home/u/proj/.git/config',
  ])('still masks %s (pre-of0 coverage, unchanged)', (filePath) => {
    expect(masksBody(filePath)).toBe(true);
  });

  // Negatives. Without these the list could widen to "any dotfile" and every
  // positive above would still pass.
  it.each([
    ['an ordinary manifest', 'package.json'],
    ['a compiler config', 'tsconfig.json'],
    ['prose', 'README.md'],
    ['source that merely mentions mcp', 'server/src/mcp_scope_smoke.ts'],
    ['documentation ABOUT the file', 'docs/mcp.json.md'],
    ['an undotted file whose name ends in the stem', 'my.mcp.json.bak'],
    ['a directory that contains the stem', 'not-a-.mcp.json-file/index.ts'],
    ['the undotted CLI-config name', 'mcp.json'],
    ['likewise', 'claude.json'],
    ['settings.json OUTSIDE .claude/', 'web/settings.json'],
    ['an editor settings file', '.vscode/settings.json'],
    // The dotted-stem fix anchors at the START of the basename. These three are
    // what stops it from becoming "any dotfile containing a scary word".
    ['a dotfile that merely starts like .env', '.envelope.json'],
    ['a dotfile that merely starts like token', '.tokenizer.json'],
    ['a dotfile that merely starts like secret', '.secretary.md'],
  ])('does NOT mask %s', (_label, filePath) => {
    expect(masksBody(filePath)).toBe(false);
  });

  it('masks the dotfile AND the undotted form of the same stem', () => {
    // The two directions of the leading-dot fix, in one test so they cannot
    // drift: `~/.aws/credentials` was always covered, `.credentials.json` was
    // not, and both are the same secret.
    expect(masksBody('/home/u/.aws/credentials')).toBe(true);
    expect(masksBody('/home/u/.claude/.credentials.json')).toBe(true);
    expect(masksBody('/home/u/.token')).toBe(true);
    // ...while `.env` — which strips to `env`, equal to no stem — still works.
    // This is the case that reddens if someone implements the fix as a REPLACE
    // of the basename rather than an additional form to test.
    expect(masksBody('/home/u/proj/.env')).toBe(true);
  });

  it('keeps the path itself readable — it is what names WHICH file leaked', () => {
    const out = redactSensitive({ filePath: '/home/u/proj/.mcp.json', content: 'BODY' })
      .redacted as Record<string, unknown>;
    expect(out.content).toBe('<redacted>');
    expect(out.filePath).toBe('/home/u/proj/.mcp.json');
  });
});

/**
 * [security] Register of0 — the SECOND copy of a sensitive file body.
 *
 * A `Read` puts the body in the payload twice. `tool_use_result.file` carries
 * `{filePath, content}` as siblings; `message.content[i]` carries a
 * `tool_result` block whose `content` is the same body with no path field on it.
 * Putting the path on the list masks copy 1 and ships copy 2 — with `fields`
 * truthfully naming the mask it did apply, which is what made the leaked export
 * look inspected.
 *
 * The payload shape below is taken verbatim from the transcript that reported
 * this, minus the real credential.
 */
describe('[security] the second copy of a sensitive file body (of0)', () => {
  // Assembled at RUNTIME. gitleaks scans text, and the `.*\.test\.ts$` blanket
  // exemption was removed — a split literal cannot match its ruleset, so the
  // secret scan keeps full strength instead of growing a by-value exemption for
  // a string that is synthetic by construction.
  //
  // 40 alphanumerics with NO vendor prefix, matching the reported value's shape
  // on purpose: it matches no SENSITIVE_VALUE_PATTERN, so only the path rule can
  // catch it. If an inline pattern ever started matching this, these tests would
  // pass for the wrong reason.
  const FILLER = 'A1b2C3d4E5f6G7h8J9k0';
  const SECRET = FILLER + FILLER;

  const MCP_BODY = JSON.stringify(
    { mcpServers: { 'project-server': { command: 'npx', env: { CLIENT_SECRET: SECRET } } } },
    null,
    2,
  );

  /** The shape a Read produces, as captured from a real session. */
  const readOf = (filePath: string) => ({
    type: 'user',
    session_id: 'sid-1',
    message: {
      role: 'user',
      content: [{ tool_use_id: 'tu_1', type: 'tool_result', content: MCP_BODY }],
    },
    tool_use_result: {
      type: 'text',
      file: { filePath, content: MCP_BODY, numLines: 5, startLine: 1, totalLines: 5 },
    },
  });

  it('masks BOTH copies and names both in fields', () => {
    const { redacted, fields } = redactSensitive(readOf('/proj/.mcp.json'));
    expect(JSON.stringify(redacted)).not.toContain(SECRET);
    expect(fields).toContain('tool_use_result.file.content');
    expect(fields).toContain('message.content[0].content');
  });

  it('leaves the block metadata readable — which call it was, and whether it failed', () => {
    const { redacted } = redactSensitive(readOf('/proj/.mcp.json'));
    const block = (redacted as { message: { content: Record<string, unknown>[] } }).message
      .content[0]!;
    expect(block.tool_use_id).toBe('tu_1');
    expect(block.type).toBe('tool_result');
  });

  // THE critical negative. Without it the rule could silently become
  // unconditional — masking every tool_result body in every session — and every
  // positive above would still pass.
  //
  // `Cebab-ygu.51` took `fields` away as the way to ask. This control used to
  // assert that `message.content[0].content` and `tool_use_result.file.content`
  // were ABSENT from `fields`; the credential-named-assignment rule now masks
  // the `CLIENT_SECRET` line INSIDE that same body, at that same path, so the
  // path is present for a completely different reason. `fields` reports WHERE a
  // mask landed and has never reported WHICH RULE put it there.
  //
  // So the control asks the output instead, and comes out sharper than it went
  // in: the two bodies are the SAME BYTES at different paths, and the
  // difference between "wholesale" and "one span" is now asserted directly
  // rather than inferred from a report that cannot tell them apart.
  it('does NOT touch a tool_result body when no sensitive path is declared', () => {
    const bodyOf = (filePath: string) =>
      (
        redactSensitive(readOf(filePath)) as {
          redacted: { tool_use_result: { file: { content: string } } };
        }
      ).redacted.tool_use_result.file.content;

    // Sensitive path: the of0 rule masks the body WHOLESALE, one token.
    expect(bodyOf('/proj/.mcp.json')).toBe('<redacted>');

    // Benign path, identical bytes: the document survives — which is what
    // "does not touch the body" has to mean, and what a rule gone unconditional
    // would destroy.
    const benign = bodyOf('/proj/README.md');
    expect(benign).toContain('mcpServers');
    expect(benign).toContain('project-server');
    // …and the credential quoted inside it is gone anyway, by the narrow rule
    // rather than the wholesale one. A README that quotes an MCP config is a
    // real shape, and shipping its client secret was never the intent here.
    expect(benign).not.toContain(SECRET);
  });

  // Pins the results-only scoping. An assistant event carries no file body, only
  // the path — masking its args would be pure signal loss.
  it('does NOT mask tool_use args, even when one names a sensitive file', () => {
    const assistant = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_a', name: 'Read', input: { file_path: '/proj/.mcp.json' } },
          { type: 'tool_use', id: 'tu_b', name: 'Read', input: { file_path: '/proj/src/foo.ts' } },
        ],
      },
    };
    const { redacted, fields } = redactSensitive(assistant);
    expect(redacted).toEqual(assistant);
    expect(fields).toEqual([]);
  });

  // The mechanism must not assume a root shape or a fixed depth: this function is
  // called with the bare SDK envelope (export), `{type, subtype, seq, payload}`
  // (WS projector), and other wrappers besides.
  it('reaches the second copy however deeply the caller nests the payload', () => {
    const wrapped = { type: 'user', subtype: null, seq: 7, payload: readOf('/proj/.mcp.json') };
    const { redacted, fields } = redactSensitive(wrapped);
    expect(JSON.stringify(redacted)).not.toContain(SECRET);
    expect(fields).toContain('payload.message.content[0].content');

    const deeper = { a: { b: { c: readOf('/proj/.mcp.json') } } };
    expect(JSON.stringify(redactSensitive(deeper).redacted)).not.toContain(SECRET);
  });

  it('masks a tool_result content array wholesale, not just a string body', () => {
    const arrayForm = {
      tool_use_result: { file: { filePath: '/proj/.mcp.json', content: MCP_BODY } },
      message: {
        content: [
          { tool_use_id: 'tu_1', type: 'tool_result', content: [{ type: 'text', text: MCP_BODY }] },
        ],
      },
    };
    expect(JSON.stringify(redactSensitive(arrayForm).redacted)).not.toContain(SECRET);
  });

  it('ignores a lookalike that carries only one of the two discriminators', () => {
    // `type: 'tool_result'` with no `tool_use_id` is not a content block, and a
    // payload-wide rule keyed on the string alone would mask unrelated prose.
    const lookalike = {
      tool_use_result: { file: { filePath: '/proj/.mcp.json', content: 'x' } },
      note: { type: 'tool_result', content: 'a description of what tool_result means' },
    };
    const { redacted } = redactSensitive(lookalike) as { redacted: Record<string, never> };
    expect((redacted.note as unknown as Record<string, unknown>).content).toBe(
      'a description of what tool_result means',
    );
  });
});

describe('[security] pinned limitation: a streaming delta is NOT this module’s job', () => {
  // `Cebab-ygu.47`, amended by `Cebab-ygu.51`. Recording what this redactor does
  // NOT do, because believing otherwise is what shipped plaintext credentials in
  // the "share-safe" export.
  //
  // Two structural reasons were recorded here, and ONE of them survived:
  //   1. A delta's text sits under the key `text`, which no KEY rule matches
  //      — still true of the key, no longer true of the text. `Cebab-ygu.51`
  //      reads the STRING for `name = value` where the NAME is credential-shaped,
  //      so a secret that arrives whole inside one delta is now masked.
  //   2. A secret CHOPPED ACROSS DELTAS is still beyond any per-line rule, and
  //      always will be — the tail carries no name to key on and no shape to
  //      match. This is the limitation that is actually structural.
  //
  // The paragraph that used to sit here said "do not fix this — a rule broad
  // enough to catch case 2 would mask every message body, which is the transcript
  // the export exists to provide." That was true of WHOLESALE masking and false
  // of span masking, and the difference was never measured until `Cebab-ygu.51`
  // measured it: the assignment rule masks 0 spans across 24 real session
  // transcripts (4390 lines), while the entropy rule it was really warning about
  // — any 32+ char mixed-case-and-digit token — masks 1544. The warning was
  // right about the cliff and wrong about where the edge was.
  //
  // The corpus answer stands regardless: `session_log_export.ts` excludes the
  // whole message class via `runner/message_classes.ts`, so none of this reaches
  // the export either way.

  // Assembled at runtime, non-vendor-shaped, so the secret scan stays at full
  // strength and the case is not accidentally passed by a vendor pattern.
  const CANARY = 'REDACTION' + '-CANARY-' + '77';

  const delta = (text: string) => ({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  });

  it('does not mask a plain secret under event.delta.text', () => {
    const { redacted, fields } = redactSensitive(delta(`plain_marker = ${CANARY}`));
    expect(JSON.stringify(redacted)).toContain(CANARY);
    expect(fields).toEqual([]);
  });

  it('masks the HEAD of a value split across deltas, because the head carries the name', () => {
    // This case used to assert that the head LEAKED — `expect(...).toContain(
    // 'correct-horse-battery-')` — and it was green for two months. A test that
    // pins the defect is indistinguishable from a test that pins the behaviour
    // until someone reads what it is asserting.
    //
    // `Cebab-ygu.51` masks it: `db_password` is in the delta, the value starts in
    // the same delta, and the rule needs nothing else.
    const head = redactSensitive(delta('db_password = correct-horse-battery-'));
    expect(JSON.stringify(head.redacted)).not.toContain('correct-horse-battery-');
    expect(head.fields).toEqual(['event.delta.text']);
  });

  it('cannot see the TAIL of that value, by construction', () => {
    // The half that is genuinely structural, and the reason the case above was
    // rewritten rather than deleted. `staple-9271` arrives with no name beside
    // it and no shape to match; a rule that caught it would have to catch every
    // hyphenated token in every transcript.
    const tail = redactSensitive(delta('staple-9271'));
    expect(JSON.stringify(tail.redacted)).toContain('staple-9271');
    expect(tail.fields).toEqual([]);
  });

  it('CONTROL: a vendor-shaped token in the same position IS masked', () => {
    // The half that keeps the two cases above from reading as "the redactor is
    // broken". It works on what it can see; the delta corpus is what it cannot.
    const vendor = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    const { redacted } = redactSensitive(delta(`key = ${vendor}`));
    expect(JSON.stringify(redacted)).not.toContain(vendor);
  });
});

describe('[security] a credential-NAMED assignment in free text (Cebab-ygu.51)', () => {
  // Every canary is assembled at RUNTIME. gitleaks scans this file and the
  // `.*\.test\.ts$` blanket exemption was removed, so a split literal keeps the
  // secret scan at full strength instead of growing a by-value exemption.
  //
  // None of them is vendor-shaped, deliberately: if one were, the wholesale
  // value-pattern branch would mask it and every case here would pass for the
  // wrong reason — which is precisely the fixture luck this bead is about.
  const PASSWORD = 'correct-horse' + '-battery-staple-' + '9271';
  const APIKEY = 'ik' + '_live_' + 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6';

  /** The durable shape the export ships and `Cebab-ygu.47` believed was safe. */
  const assistantSaying = (text: string) => ({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });

  it('masks the value and names the path', () => {
    // The finding. Reddens: removing the call in `walk`'s string branch, which
    // ships this verbatim in the redacted export.
    const { redacted, fields } = redactSensitive(
      assistantSaying(`the file says db_password = ${PASSWORD}`),
    );
    expect(JSON.stringify(redacted)).not.toContain(PASSWORD);
    expect(fields).toEqual(['message.content[0].text']);
  });

  it('leaves the prose and the key name readable — only the value goes', () => {
    // Reddens: masking the whole string. The transcript is what the export
    // exists to provide, and an operator who cannot see WHICH name was masked
    // cannot act on it.
    const { redacted } = redactSensitive(
      assistantSaying(`I read deploy-notes.txt: db_password = ${PASSWORD}. Rotate it.`),
    );
    const text = (redacted as { message: { content: { text: string }[] } }).message.content[0]!
      .text;
    expect(text).toBe('I read deploy-notes.txt: db_password = <redacted>. Rotate it.');
  });

  it('masks the ASSIGNMENT and leaves a bare repeat — a measured trade, not an oversight', () => {
    // This case used to assert the opposite, and the implementation used to
    // replace every occurrence of a matched value. Measured against 24 real
    // session transcripts, that pass turned ONE match on `session_id: sessionId`
    // inside a `Read` of `ws/server.ts` into twenty mangled lines — the
    // identifier `sessionId` scrubbed wherever it appeared in the file.
    //
    // One match destroying a whole body is not the "false positives are cheap"
    // this module licenses, and the repeat case was hypothetical: no transcript
    // in the corpus had one. So the rule masks exactly what it matched.
    //
    // Reddens in both directions: an implementation that masks nothing here, and
    // one that reinstates the repeat pass.
    const { redacted } = redactSensitive(
      assistantSaying(`internal_api_key = ${APIKEY} — so export KEY then use ${APIKEY}`),
    );
    const text = (redacted as { message: { content: { text: string }[] } }).message.content[0]!
      .text;
    expect(text).toBe(`internal_api_key = <redacted> — so export KEY then use ${APIKEY}`);
  });

  it('a rejected pair earlier in the line does not swallow the real one', () => {
    // Found by writing the case above as a SENTENCE rather than as a bare
    // `key = value`. `exec` leaves lastIndex past the whole match, so the pair
    // (`deploy-notes.txt`, `db_password`) was matched, rejected on its name, and
    // consumed the assignment that followed it — masking nothing while every
    // bare-pair test stayed green.
    //
    // Reddens: dropping the rewind to `match.index + name.length`.
    const { redacted } = redactSensitive(
      assistantSaying(`ran cat deploy-notes.txt: db_password = ${PASSWORD}`),
    );
    expect(JSON.stringify(redacted)).not.toContain(PASSWORD);
  });

  it('a sentence-final period is punctuation, not key material', () => {
    // Reddens: dropping the trailing-dot trim, which masks the period along with
    // the value and silently rewrites the prose around it.
    const { redacted } = redactSensitive(assistantSaying(`db_password = ${PASSWORD}. Rotate it.`));
    const text = (redacted as { message: { content: { text: string }[] } }).message.content[0]!
      .text;
    expect(text).toBe('db_password = <redacted>. Rotate it.');
  });

  it('the accepted vocabulary IS isSensitiveKey, not a second list', () => {
    // Reddens: restating the key words inside the pattern. `session_id` is in
    // SENSITIVE_KEY_PATTERNS and would be easy to leave out of a hand-copied
    // alternation; `author` is excluded there by a lookahead that a copy would
    // lose. Both are asserted so the two directions of drift fail separately.
    const masked = redactSensitive(assistantSaying(`session_id = ${APIKEY}`));
    expect(JSON.stringify(masked.redacted)).not.toContain(APIKEY);

    const untouched = redactSensitive(assistantSaying(`author = ${APIKEY}`));
    expect(JSON.stringify(untouched.redacted)).toContain(APIKEY);
    expect(untouched.fields).toEqual([]);
  });

  it('accepts the separators and quoting a transcript actually contains', () => {
    for (const line of [
      `db_password: ${PASSWORD}`,
      `"api_key": "${PASSWORD}"`,
      `export CLIENT_SECRET='${PASSWORD}'`,
      `ANTHROPIC_API_KEY=${PASSWORD}`,
    ]) {
      const { redacted } = redactSensitive(assistantSaying(line));
      expect({ line, leaked: JSON.stringify(redacted).includes(PASSWORD) }).toEqual({
        line,
        leaked: false,
      });
    }
  });

  it('leaves prose and code references alone', () => {
    // Both directions of the value filter, in one case, so neither "mask
    // nothing" nor "mask everything" can pass it. Measured false positives from
    // this repo's own sources — the stand-in for code quoted in a transcript.
    for (const line of [
      'the token is rotated weekly',
      'const token = authTokenRef.current',
      'const key = crypto.randomBytes(32)',
      'let secret = undefined',
      'apiKeySource = process.env.ANTHROPIC_API_KEY',
    ]) {
      const { redacted, fields } = redactSensitive(assistantSaying(line));
      const text = (redacted as { message: { content: { text: string }[] } }).message.content[0]!
        .text;
      expect({ line, text, fields }).toEqual({ line, text: line, fields: [] });
    }
  });

  it('a vendor-shaped token in the same string still masks WHOLESALE', () => {
    // Reddens: putting the new rule BEFORE the value-pattern branch. A vendor
    // token is unambiguous evidence the whole string is credential-bearing, and
    // downgrading that to a span would be this change removing masking — the one
    // direction it must never move.
    const vendor = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    const { redacted } = redactSensitive(assistantSaying(`db_password = ${PASSWORD} ${vendor}`));
    const text = (redacted as { message: { content: { text: string }[] } }).message.content[0]!
      .text;
    expect(text).toBe('<redacted>');
  });

  it('is a fixed point — redacting twice changes nothing', () => {
    // Reddens: a rule that can match its own output. `<redacted>` contains `<`
    // and `>`, which the value class rejects, so this holds by construction —
    // and by construction is exactly the kind of claim that stops being true
    // when someone widens a character class.
    const once = redactSensitive(assistantSaying(`db_password = ${PASSWORD}`)).redacted;
    const twice = redactSensitive(once);
    expect(JSON.stringify(twice.redacted)).toBe(JSON.stringify(once));
    expect(twice.fields).toEqual([]);
  });

  it('KNOWN LIMIT: a value with no credential-shaped name still leaks', () => {
    // Pinned, not hidden. `plain_marker` is not a credential name and the value
    // matches no pattern, so nothing distinguishes this from prose. Reaching it
    // means an entropy rule, MEASURED at 1544 masked spans across 4390 lines of
    // real transcripts against this rule's 0 — see the module header.
    //
    // The case exists so the next person meets the number before the idea.
    const marker = 'REDACTION' + '-CANARY-' + '7f3a';
    const { redacted, fields } = redactSensitive(assistantSaying(`plain_marker = ${marker}`));
    expect(JSON.stringify(redacted)).toContain(marker);
    expect(fields).toEqual([]);
  });

  it("the bead's control: masking no longer depends on an unrelated secret nearby", () => {
    // `Cebab-ygu.47` measured "leaks OUTSIDE stream_event: NONE" and it was
    // fixture luck — the durable copies carried an AKIA key in the same string,
    // and the wholesale branch masked everything around it. Take the vendor
    // token away and the marker used to walk straight out.
    //
    // Both halves asserted together, because the whole finding IS the delta
    // between them.
    const vendor = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    const withVendor = redactSensitive(assistantSaying(`db_password = ${PASSWORD} ${vendor}`));
    const without = redactSensitive(assistantSaying(`db_password = ${PASSWORD}`));
    expect(JSON.stringify(withVendor.redacted)).not.toContain(PASSWORD);
    expect(JSON.stringify(without.redacted)).not.toContain(PASSWORD);
    expect(without.fields).toEqual(['message.content[0].text']);
  });
});
