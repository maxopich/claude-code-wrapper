#!/usr/bin/env node
/**
 * PreToolUse deny hook for autonomous-loop BUILD sessions (§7.3).
 *
 * THE HOOK IS THE HARD BOUNDARY, not an `--allowedTools` pattern list. A
 * pattern list is an ALLOW decision made in advance about strings nobody has
 * seen yet, and getting it subtly wrong fails open. This fails closed on the
 * shapes below, and the reasons it gives back are the harness's own invariants.
 *
 * Why each entry is here — none is generic caution:
 *   npm install / ci / yarn / pnpm  the lockfile must not change; CI runs
 *                                   `git diff --exit-code package-lock.json`
 *   git commit/push/merge/rebase    the driver owns publication
 *   git checkout/switch/reset       the driver owns branch state; a stray
 *                                   checkout strands the work on main
 *   gh                              the driver owns the forge
 *   --no-verify                     bypasses lint-staged + gitleaks
 *   rm -rf                          blast radius
 *
 * MATCHING IS AT COMMAND POSITION, NOT SUBSTRING, and that distinction is the
 * whole difference between a usable hook and one the agent fights. A plain
 * `/\bgh\b/` over the command line denies `grep -rn gh .`; `/\bgit commit\b/`
 * denies `git log --grep "git commit"`. Both are ordinary read-only work, and
 * an agent that cannot search the repo will work around the hook rather than
 * respect it. So the command is split on shell separators and only the leading
 * token of each segment is treated as a command.
 *
 * Anything it cannot parse is ALLOWED: a hook that crashed closed on malformed
 * input would block the whole run for a reason nobody could see, and the
 * driver's own guard still refuses the resulting diff at PUBLISH.
 */

/** Leading token of each `|`, `;`, `&&`, `||`, newline-separated segment,
 *  skipping `FOO=bar` env prefixes and `sudo`/`command`/`env` wrappers. */
export function commandHeads(command) {
  const heads = [];
  for (const segment of String(command).split(/\|\||&&|[|;\n]/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (
      i < tokens.length &&
      (tokens[i].includes('=') || ['sudo', 'command', 'env', 'nohup', 'time'].includes(tokens[i]))
    ) {
      i += 1;
    }
    if (i < tokens.length)
      heads.push({ head: tokens[i], args: tokens.slice(i + 1), segment: segment.trim() });
  }
  return heads;
}

const base = (h) => h.slice(h.lastIndexOf('/') + 1);

const RULES = [
  {
    hit: (h) => base(h.head) === 'npm' && ['install', 'i', 'ci'].includes(h.args[0]),
    why: 'the lockfile must not change — CI fails on drift, and the harness never runs npm install either',
  },
  {
    hit: (h) => ['yarn', 'pnpm'].includes(base(h.head)),
    why: 'this repo uses npm workspaces; another package manager would rewrite the lockfile',
  },
  {
    hit: (h) =>
      base(h.head) === 'git' &&
      ['commit', 'push', 'merge', 'rebase', 'cherry-pick'].includes(h.args[0]),
    why: 'the harness commits and publishes, after re-running every gate you ran',
  },
  {
    hit: (h) => base(h.head) === 'git' && ['checkout', 'switch', 'reset'].includes(h.args[0]),
    why: 'the harness owns branch state; changing it strands your work',
  },
  {
    hit: (h) => base(h.head) === 'gh',
    why: 'the harness owns the forge — it opens the PR and merges it',
  },
  {
    hit: (h) =>
      base(h.head) === 'rm' &&
      h.args.some((a) => a.startsWith('-') && a.includes('r') && a.includes('f')),
    why: 'blast radius — delete specific paths instead',
  },
  {
    // A flag, so this one IS a substring check — but only over the segment
    // whose head is git, so `grep -- --no-verify` stays allowed.
    hit: (h) => base(h.head) === 'git' && h.args.includes('--no-verify'),
    why: 'that bypasses the pre-commit lint-staged + gitleaks gate',
  },
];

export function decide(command) {
  for (const h of commandHeads(command)) {
    const rule = RULES.find((r) => r.hit(h));
    if (rule) return rule.why;
  }
  return null;
}

// Only run as a hook when executed directly, so the tests can import `decide`.
if (process.argv[1] && process.argv[1].endsWith('loop-guard.mjs')) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    raw += c;
  });
  process.stdin.on('end', () => {
    let call;
    try {
      call = JSON.parse(raw);
    } catch {
      process.exit(0); // unparsable -> allow; see the header
    }
    if (call.tool_name !== 'Bash') process.exit(0);
    const why = decide(call.tool_input?.command ?? '');
    if (!why) process.exit(0);
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `Denied by the autonomous loop: ${why}`,
        },
      }),
    );
    process.exit(0);
  });
}
