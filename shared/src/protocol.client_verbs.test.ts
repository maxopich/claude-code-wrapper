import { describe, expect, test } from 'vitest';
import type { ClientMsg } from './protocol.js';

// Cebab-8x8.3.1: the built-in assistant reuses `send_message`, `interrupt` and
// `load_session` byte-for-byte — it introduces NO new client→server verb. This
// test freezes that fact so it stays deliberate.
//
// The freeze is enforced at COMPILE time, not just at runtime: vitest's esbuild
// transform strips types without checking them, so the two `extends` assertions
// below only bite under `npm run typecheck` (the same mechanism
// `protocol.controllability.test.ts` relies on). A future `assistant_send` — or
// any new ClientMsg arm — added to the union without a matching entry here makes
// `MissingFromList` resolve to that verb instead of `never`, and the
// `_noneMissing` assignment fails to compile. So forking the run path with a new
// verb becomes a conscious edit to this list, caught in CI, rather than a quiet
// second send path that diverges from the assistant's reuse of `send_message`.

const CLIENT_MSG_VERBS = [
  'abandon_session',
  'ack_notification',
  'acknowledge_and_start',
  'add_multi_agent_participant',
  'archive_session',
  'bulk_session_op',
  'bus_trust_decision',
  'cancel_auth_refresh',
  'cancel_gate',
  'clear_dismissed_inbox',
  'clear_iterations',
  'continue_multi_agent',
  'continue_through_mutation',
  'copy_project_to_managed',
  'delete_stray_session_folders',
  'delete_template',
  'get_artifact_content',
  'get_kick_forensics',
  'get_last_run_for_template',
  'get_model_catalogue',
  'get_project_authority',
  'get_recovery_log_snapshot',
  'get_settings',
  'get_storage_stats',
  'get_stray_session_folders',
  'install_bus_integration',
  'interrupt',
  'kick_participant',
  'list_iterations',
  'list_projects',
  'list_templates',
  'load_session',
  'load_session_log',
  'mcp_trust_decision',
  'multi_agent_ask_user_answer',
  'multi_agent_user_prompt',
  'mute_participant',
  'open_project',
  'pause_participant',
  'permission_decision',
  'preflight_managed_copy',
  'read_managed_file',
  'read_project_facts',
  'rename_session',
  'reopen_session',
  'reopen_session_confirmed',
  'request_inbox_snapshot',
  'resume_multi_agent',
  'resume_participant',
  'retry_rate_limited',
  'retry_worker',
  'save_template',
  'search_sessions',
  'send_message',
  'set_default_hop_budget',
  'set_default_max_turns',
  'set_multi_agent_lifecycle',
  'set_permission_mode',
  'set_project_model',
  'set_project_start_permission_mode',
  'set_trusted',
  'set_workspace_root',
  'start_auth_refresh',
  'start_multi_agent',
  'stop_multi_agent',
  'stop_reason',
  'uninstall_bus_integration',
  'unmute_participant',
  'write_managed_file',
] as const;

type ClientMsgVerb = ClientMsg['type'];

// Direction 1 (compile-time): every listed string is a real ClientMsg verb.
// A typo or a removed verb makes this annotation fail to compile.
const _allListedAreReal: readonly ClientMsgVerb[] = CLIENT_MSG_VERBS;
void _allListedAreReal;

// Direction 2 (compile-time): no ClientMsg verb is missing from the list.
// A new union arm makes `MissingFromList` that verb, not `never`.
type MissingFromList = Exclude<ClientMsgVerb, (typeof CLIENT_MSG_VERBS)[number]>;
const _noneMissing: [MissingFromList] extends [never] ? true : false = true;

describe('ClientMsg verb set is frozen (Cebab-8x8.3.1)', () => {
  test('assistant introduces no new client verb — the list has no duplicates', () => {
    // `assistant_send` (or any new verb) would have to be added above, and the
    // compile-time checks force that. The runtime side just guards the list
    // itself: a duplicate entry would silently weaken the exhaustiveness intent.
    expect(new Set(CLIENT_MSG_VERBS).size).toBe(CLIENT_MSG_VERBS.length);
    expect(_noneMissing).toBe(true);
  });

  test('no assistant-specific send verb has been added', () => {
    // A named negative: the exact verb the issue warns about must be absent.
    // If a real `assistant_send` arm ever lands, Direction 2 above stops
    // compiling; this keeps the intent legible at the runtime layer too.
    expect(CLIENT_MSG_VERBS).not.toContain('assistant_send');
    expect(CLIENT_MSG_VERBS).toContain('send_message');
  });
});
