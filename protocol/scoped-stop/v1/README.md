# Scoped stop v1 (adapter 0.1.4)

Additive to extension protocol **2**. Existing `protocol/v1` and `protocol/v2`
bytes, `session/cancel`, and `deepseek/subagent/interrupt` are unchanged.
No new initialize metadata is required; consumers gate on adapter version.

## Client request: `deepseek/session/stop`

- `{ "kind": "session", "sessionId": "owned-resident-root" }`
- `{ "kind": "child", "sessionId": "exact-parent", "childSessionId": "child" }`
- Result: `{ "workKept": false }` (or `true`). No response IDs or synthetic terminal events.
- Invalid shape, unknown root/child, or wrong parent: invalid-params, before effects.
- An ended retained child may authorize its remaining live delegated subtree.

`workKept` reports genuinely retained activity, not pending cancellation settlement.
An independently named live one-shot or child with missing/inherited identity is
retained; STOP never broadens to its parent or the parent's other jobs. Children
with own-suffix continuable provenance receive the public `Agent.cancel` with
`keepInbox: false`: STOP discards accepted queued/steering input. The old manager
interrupt intentionally keeps that input and is **not** the STOP mechanism.
This direct-call distinction was approved during implementation after inspecting
the pinned public API. No Activation disposal is requested or awaited.

The endpoint captures the native live subtree, its own descriptor projections,
and its launchers' complete running/stopping subagent job set synchronously.
Then it signals the root activity, continuable children, and those exact jobs,
without yielding. It never kills bash, unowned, parent, sibling, or foreign jobs.
A foreground one-shot is covered through its launching activity's abort signal;
a background fork is covered by the complete owned subagent job set. No guessed
per-child job binding is needed when stopping the launcher and **all** its jobs.
An independently named one-shot has no exact job binding in the pinned registry
and remains retained. No new adapter state, fence, admission cutoff, rescan,
cleanup sweep, or timer is introduced. Later work is not claimed by the request.

Cancellation-hook failures are diagnosed with operation, session/job and original
cause. Independent branches are still signalled, then an `AggregateError` retains
the contextual errors/causes (ACP transports it as an internal-error response).
There is no successful `workKept` result after a partial hook failure.

## Server request: `deepseek/input/cancel`

Params: `{ "sessionId": "input-owner" }`. Client acknowledgement: `{}`.
This is a **request**, never a notification. A consumer handles it in the same
ordered request channel as permissions and `deepseek/ask_user_question`, cancelling
only inputs pending at that ordered point. New inputs afterward survive, even
when question IDs are reused. It does not own turn generations or stop state.

Only a sent interaction installs a request-local abort callback. Abort queues the
control write through SDK `extMethod` before the cancelled interaction releases
its output tail. The race is **inside** that tail's task. The adapter never waits
for the old raw response or control acknowledgement; failures are observed and
logged. A separate caller-side race preserves cancellation latency for an input
still behind previous output, whose pre-send abort check sends nothing. Callbacks
are removed at settlement. Ordering is old input → input-cancel → next input.

## Pinned atomicity evidence

All dsh components below are locked to `0.1.1-rc.2`; ACP SDK is `0.25.1`.
Relevant shipped implementation seams (under `node_modules/@deepseek-ai`):

- `dsh-subagent/lib/index.js`: `materializeTracked`, `submitAdmitted`, `submit`:
  creation is signal-bound and the final admission check immediately precedes
  submit without an await. `subagent` live projection exposes `{mode, seq}`;
  native requires `origin === "subagent"` and `seq >= (seedLength ?? 0)`.
- `dsh-subagent-in-process-driver/lib/index.js`: `startInProcessRun`,
  `drivePublishedRun`: after publication the parent signal is wired and checked
  synchronously before initial followup; abort forwards to the real child.
- `dsh-tool-subagent/lib/index.js`: background non-continuable branch uses
  `jobs.start({kind: "subagent", owner: parent, run: ...})`; its independent
  controller is returned synchronously as the job cancel hook. Foreground uses
  `exec.signal`; these exhaust the one-shot producers in the pinned profile.
- `dsh-jobs-local/lib/index.js`: synchronous registration/list/kill; kill invokes
  the producer hook before returning, without broad owner teardown.
- `dsh-agent-loop/lib/index.js`: `cancel` synchronously clears inbox and aborts
  active phase; it does not arm later work. Inbox discards update the manager's
  accepted set via existing listeners.
- ACP SDK `dist/acp.js`: `extMethod` → `sendRequest` queues the writer before
  returning its pending RPC response promise.

`test/scoped_stop.test.ts` boots the full pinned runtime. It uses real agent,
projection, subagent producer/manager, job registry, maintenance/turn signals,
and SDK writer. It holds ACP announcements and the real registry's create return
(after publication, before admission/handoff), and asserts cancellation **before
awaiting** STOP. Background forks, pending and published children, nested/ended
lineage, later work, inbox discard, scope isolation, failed hooks, provenance,
permissions and reused-id questions are covered. These are controlled native
admission/I/O interleavings, not bridge notification fakes or phone E2E.

## Release boundary

The existing native release workflow checks out its configured consumer commit
and runs vendored consumer tests. It is DTO/unit conformance, not a live adapter
injection or new-endpoint test. That unchanged gate passes at
`69e9478d681d97d6a0f1b2d7b1f0baf03a0cd71c` (81 tests). This consumer does not yet
handle `deepseek/input/cancel`; the native negative-ACK test proves that an
unsupported request is logged and does not deadlock output, not that consumer
inputs are cleaned up. Matching new-endpoint DTOs/corpus source manifests and
phone/desktop coverage remain consumer work. Do not claim atomic end-to-end STOP
until that consumer and verified release pin land. No tag/publish is performed
by this implementation, and `release/config.json` is unchanged.
