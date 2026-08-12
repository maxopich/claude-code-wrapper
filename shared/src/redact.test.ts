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
