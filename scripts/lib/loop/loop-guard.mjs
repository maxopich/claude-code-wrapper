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
 *
 * THE HOOK ALSO SAYS YES, and it has to. Claude Code auto-approves Bash it can
 * classify as safe but requires approval for `npm`/`npx`/`node`, and `-p` has
 * no approver — so staying silent about them means REFUSED. Measured with the
 * loop's own flags:
 *
 *   echo HELLO_FROM_BASH   -> ran,     denials []
 *   npm run typecheck      -> REFUSED, "This command requires approval"
 *   npm run typecheck      -> ran,     denials []   (hook returns `allow`)
 *
 * The agent could therefore not run a single gate command. Its own PR summary
 * said so: "Gates NOT run: npm/vitest/node all need approval unavailable in
 * this loop; verified statically." Two consequences beyond the obvious one: an
 * agent that cannot check its work writes blind, and `verdict.tests
 * .commands_run` is always empty — so `compareVerdictToGate` is STRUCTURALLY
 * always `unknown` and the spec's second governing rule, "the agent's report
 * is not evidence", can never record agreement or disagreement because there
 * is never a claim. A cheaper model spent all forty of its turns retrying a
 * command that was never going to run.
 *
 * WHAT THIS COSTS, STATED PLAINLY. `npm`/`npx`/`node` can spawn anything, so a
 * determined agent could route around the deny list — `node -e` reaches
 * `git push` as easily as typing it. The deny rules stop the HONEST MISTAKE,
 * the agent that helpfully commits and publishes; they were never a sandbox.
 * Until now the approval gate happened to be backing them up, and the price of
 * that accident was that no gate command ran at all. What remains real: the
 * driver re-runs every gate itself and does not believe the verdict, the
 * PUBLISH guard refuses the diff, `lockfileChanged()` catches drift, and the
 * tree is reset and cleaned between iterations.
 *
 * DENY IS EVALUATED FIRST and wins outright, so nothing below can widen it.
 */

/**
 * Split on shell separators WITHOUT breaking inside quotes.
 *
 * A naive `.split(/\|\||&&|[|;\n]/)` treats the `|` inside `grep -E 'a|b'` as
 * a pipe. Measured: the agent's `npx vitest … | grep -E '✓|×|PASS|FAIL'` became
 * segments headed `grep -E '✓`, `×`, `PASS` — none allowable — so a legitimate
 * command was refused and a turn was spent. The deny direction is worse:
 * `grep -E 'a|git push'` would split to a segment headed `git`, and a
 * read-only grep would be DENIED as a push.
 *
 * Not a shell parser — just quote and escape awareness, which is the whole gap.
 */
export function splitSegments(command) {
  const s = String(command);
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      cur += ch;
      // Inside double quotes a backslash escapes; inside single quotes it does not.
      if (ch === '\\' && quote === '"' && i + 1 < s.length) {
        cur += s[i + 1];
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < s.length) {
      cur += ch + s[i + 1];
      i += 1;
      continue;
    }
    if (ch === '&' && s[i + 1] !== '&') {
      // A LONE `&` IS USUALLY A REDIRECTION, NOT A SEPARATOR. `2>&1` and
      // `&>log` are the shapes the agent actually writes, and splitting them
      // left segments headed `1` — none allowable — so `npx vitest … 2>&1`
      // was refused and the turn was spent. Measured on a real capped session:
      // this shape accounted for most of its refusals. Only a `&` that is
      // neither preceded nor followed by `>` backgrounds a command.
      const prev = cur.trimEnd().slice(-1);
      if (prev === '>' || s[i + 1] === '>') {
        cur += ch;
        continue;
      }
    }
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '&') {
      if ((ch === '|' || ch === '&') && s[i + 1] === ch) i += 1; // `||`, `&&`
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Leading token of each `|`, `;`, `&&`, `||`, newline-separated segment,
 *  skipping `FOO=bar` env prefixes and `sudo`/`command`/`env` wrappers. */
export function commandHeads(command) {
  const heads = [];
  for (const segment of splitSegments(command)) {
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

/**
 * The `bd` verbs that only READ. Everything else is denied — FAIL CLOSED, which
 * is the opposite of how `git` is handled and deliberately so: git's verb set is
 * stable and famous, while `bd`'s grows, and a new mutating verb must not become
 * allowed by having been unknown when this list was written.
 */
const BD_READ_VERBS = Object.freeze([
  'show',
  'list',
  'ready',
  'search',
  'blocked',
  'stats',
  'orphans',
  'stale',
  'doctor',
  'lint',
  'memories',
  'prime',
  'preflight',
  'version',
  'help',
]);

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
    // THE HARNESS OWNS THE TRACKER TOO, and only the forge half was enforced.
    // `bd` sits on the read-only allow list below so the agent can `bd show`,
    // and nothing stopped `bd close`, `bd create`, or — worst —
    // `bd update <id> --remove-label loop-stuck`, which is the loop's ONLY
    // cross-run memory of a bead that failed. Stripped, a bead that parks every
    // night is re-selected every night, and the mechanism that exists to stop
    // exactly that is silently disarmed.
    //
    // HARVEST is the only stage that writes bead state, which is what both
    // governing rules rest on: the driver owns control flow, and the agent's
    // report is not evidence. Measured 2026-08-27 — `bd close`, `bd create` and
    // the label strip all returned an explicit ALLOW. `Cebab-qd2.31`.
    hit: (h) => base(h.head) === 'bd' && !BD_READ_VERBS.includes(h.args[0]),
    why: 'the harness owns the tracker — HARVEST closes, parks and files, after re-running your gate',
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

/**
 * Commands the loop NEEDS the agent to run. Deliberately narrow: the gate's own
 * verbs plus the test runner, matched at command position like the deny rules.
 * `npm` appears here only for `run`/`test`/`exec` — `install`/`ci` are denied
 * above and deny wins.
 */
/**
 * Read-only inspection. Claude Code auto-approves the simplest of these on its
 * own, but not consistently: measured in one capped session, `bd show` was
 * refused outright and `grep -no … | sort -u -t: -k2` was refused because ONE
 * part of the pipeline needed approval. Every such refusal costs a turn, and
 * turns are the budget that ends the build.
 *
 * These modify nothing the agent cannot already modify — it holds Edit and
 * Write under `acceptEdits`, so file contents were never the boundary. The
 * boundary is publication, the lockfile and blast radius, and all three stay in
 * the deny list, which is evaluated first.
 */
const READ_ONLY = [
  'grep',
  'rg',
  'find',
  'cat',
  'head',
  'tail',
  'wc',
  'ls',
  'sort',
  'uniq',
  'cut',
  'awk',
  'sed',
  'echo',
  'basename',
  'dirname',
  'realpath',
  'diff',
  'jq',
  'tr',
  'printf',
  'tee',
  'xargs',
  // Shell plumbing. `cd` was 16 of one session's 35 bash calls — the agent
  // prefixes nearly everything with `cd <repo> && …`, and a single unallowable
  // segment refuses the whole compound. `cp`/`mv`/`mkdir`/`touch` write, but
  // the agent already holds Edit and Write under `acceptEdits`, so file
  // contents were never the boundary. `rm` is deliberately absent: `rm -rf` is
  // denied above and a bare `rm` can keep deferring.
  'cd',
  'pwd',
  'true',
  'false',
  'test',
  'mkdir',
  'touch',
  'cp',
  'mv',
  // `git` as a whole: its dangerous subcommands are denied above, and deny
  // wins, so this reaches `log`/`show`/`diff`/`status` and nothing else.
  'git',
  // The tracker. The prompt already embeds the bead body, but the agent
  // reaches for `bd show` anyway and paid two turns for it.
  'bd',
];

const ALLOW = [
  (h) => base(h.head) === 'npm' && ['run', 'test', 'exec'].includes(h.args[0]),
  (h) => base(h.head) === 'npm' && h.args.includes('exec'),
  (h) => ['npx', 'node', 'tsc', 'vitest', 'eslint', 'prettier'].includes(base(h.head)),
  (h) => READ_ONLY.includes(base(h.head)),
];

/** Why this command should be explicitly allowed, or null to defer. */
export function allowReason(command) {
  // Deny is re-checked HERE as well as in the hook body. The hook already asks
  // in the right order, but `git` is on the read-only list while `git push` is
  // denied, so this function alone would answer "allowable" for a command the
  // loop refuses. Belt and braces: a future refactor that reorders the two
  // checks cannot make this fail open.
  if (decide(command)) return null;
  const heads = commandHeads(command);
  if (heads.length === 0) return null;
  // EVERY segment must be allowable: `npm run lint && git push` must not ride
  // in on its first half.
  if (!heads.every((h) => ALLOW.some((rule) => rule(h)))) return null;
  return 'a verification command the harness re-runs itself';
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
    const command = call.tool_input?.command ?? '';
    const emit = (permissionDecision, permissionDecisionReason) => {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision,
            permissionDecisionReason,
          },
        }),
      );
      process.exit(0);
    };

    // Deny first, always: an allow rule must never be able to widen the list.
    const why = decide(command);
    if (why) emit('deny', `Denied by the autonomous loop: ${why}`);

    const ok = allowReason(command);
    if (ok) emit('allow', `Allowed by the autonomous loop: ${ok}`);

    process.exit(0); // defer to the normal permission flow
  });
}
