# Pre-PR review fixes (2026-09-27)

Four reviews of `rebuild/owner-flow` against `main`: CodeRabbit CLI (9 directories, 30 findings), a
subagent on security/API/CLI/gateways (12), a subagent on the owner runtime and drivers (11), Codex on
core/MCP/connectors/replay (8). Duplicates are merged below; each item names its sources
(CR = CodeRabbit, A, B, CX = Codex). Every item is checked against the code before and after the fix.
Owner decision recorded here: the credential boundary covers MAMA's own credential files only
(auth.env, config.yaml, runtime/, the Codex home, the replay key); AGENTS.md says so plainly.

## F1 — owner runtime, delivery, gateways, viewer, CLI (packages/standalone)

1. HIGH (B) An owner message whose turn failed or was interrupted after dispatch is never answered
   and never gets the interrupted notice: `isPending` treats every claimed row as pending and
   `reconcile` returns unresolved for owner messages. Deliver a stored result through onOwnerResult,
   otherwise park the row uncertain (logged) so Telegram sends the interrupted notice; same no-silence
   rule for orphaned source_delta and native_event rows.
2. MED (B, A#11) The agent can write `<workspace>/.claude/settings*.json` (Edit rule and sandbox write
   cover it) and the host merges instead of rewriting, so an injected hook survives restarts and runs
   outside the Bash sandbox. Deny Edit/Write and sandbox writes under `<workspace>/.claude`; the host
   writes both settings files whole; one writer (drop the daemon's early call with an empty denyRead).
3. MED (B, CR) The replay source ceiling is ambient state; an owner row can consume it and a replay
   delta then runs unbounded. Take the ceiling from the row's own replay payload.
4. MED (B) Add the resolved `jev.keyFile` to the credential read denies.
5. MED (B) Wrap `memory.read:provenance` results as untrusted content.
6. MED (B) A failed live `[notify]` send is lost: resend `ready` outbound entries on recovery (or
   deliver the stored result from reconcile).
7. MED (A, CR) Security alerts dedupe on class+path, so a scanner can flood Telegram: one alert per
   class per window with a suppressed count; every event is still recorded. A 404 on a tunnelled path
   with no identity is not auth_failed.
8. MED (A) `mama status|stop` read a pid file nothing writes: implement both with launchd
   (`launchctl print` / `bootout gui/<uid>/com.mama.server`) and delete the pid code.
9. MED (A) Telegram polling death leaves the daemon up and deaf: a fatal polling error exits the
   process loudly so launchd restarts it.
10. MED (A) `source.attachment.download` follows a symlinked directory and writes outside the
    workspace (daemon is not sandboxed): realpath containment after mkdir, temp file opened `wx`;
    same for Telegram attachment writes (A#6).
11. MED (CR) `presenter.finalize` failure keeps a stale presenter: drop it and rethrow.
12. MED (CR) Validate every enabled connector's poll interval before creating any timer.
13. MED (CR) The lesson resolver passes only `options.scopes`; use the owner access scopes.
14. LOW (A) Images over 10 MB go as documents; failed file claims are marked, not left processing.
15. LOW (A) Skip `document` when `animation` is present (double download).
16. LOW (A, CR) Refetch the Access JWKS once, rate-limited, on an unknown `kid`.
17. LOW (A) Drop the viewer's localhost CORS echo.
18. LOW (A) File delivery opens once with O_NOFOLLOW and fstat, then streams that handle.
19. LOW (A) The CLI prints the error name and code for unexpected failures.
20. LOW (B) Scheduled report sends use `report:<hourKey>:<full|reminder>` as the idempotency key.
21. LOW (B) The SIGKILL after a timeout never fires (`killed` is set on SIGTERM): track exit.
22. LOW (B) Remove the prompt sentences that promise late delivery / recommend run_in_background.
23. LOW (B) The report prompt's lodging line is owner business content: remove it from source; the
    owner policy file carries it.
24. LOW (B, CR) Connector poll failures: catch and log in `pollConnector`, `pollOne`, `pollAll`.
25. MINOR (CR) `source.attachment.download` checks the fileId belongs to the observation.

## F2 — connectors and replay (packages/standalone)

1. HIGH (CX) Failed historical imports leave pages pending, and live admission consumes them as live
   deltas (Trello and Kagemusha imports): persist collect-only intent; live admission excludes them.
2. HIGH (CX, CR) Chatwork advances per-room cursors before a later room fails: stage cursors and
   commit through the begin/commit/abort handoff Trello uses.
3. MED (CX) Replay catalog JSON.parses every Trello row; live snapshots are text: render by the stored
   representation.
4. MED (CR) Kagemusha channel keys: the scheduler and `accepts` must resolve the same keys.
5. MED (CR) Kagemusha timestamps: `since`, comparisons and the keyset cursor use the stored columns'
   representation.

## F3 — mama-core, MCP server, plugin, migrations

1. HIGH (CX) The secret scan misses `sk-proj-…` and `github_pat_…`: add both to scan and redaction.
2. MED (CX, CR) Migration handlers for 72/73/74/77/79 and `repairSkippedFeatureMigrations` run for
   consumer sources: gate on the core source.
3. MED (CX) Instance-bound recall expands the graph through the global database: use
   `expandWithGraphInAdapter(adapter, …)`.
4. MED (CX) Graph observation search deletes `%`, `_`, `\` instead of escaping them.
5. MED (CX) Timeline limits apply before recorded-time filtering; report whether more exist.
6. MED (CR) `host.onRunFinished` observer errors must not fail a committed turn.
7. MED (CR) `stmtPendingCoalesced` excludes rows whose native delivery is not prepared.
8. MED (CR) `boundReadScopesFor` dedupes scopes with a separator-safe key.
9. MED (CR) `getGraphPaths` bounds its frontier and edge work and reports limit_reached.
10. MED (CR) `memory.update` checks the record's scope bindings against the caller's scopes.
11. MED (CR) `memory.checkpoint.save` is a recallable write (secret scan).
12. MED (CR) Resolved identities are checked for visibility before hydration in current-history mode.
13. MED (CR) Korean alternatives in the question vocabulary match with particles attached.
14. MED (CR) `source.ingest` rejects the reserved `owner-message:`/`owner-result:` prefixes.
15. MED (CR) IPC: `encodeFrame` failures settle the promise; `settle` clears the timer.
16. MED (CR) New migration 097: the model_run_native_inputs view guards `json_extract` with json_valid
    (095 is applied; not edited).
17. MINOR (CR) `sortScopes` gives unknown kinds a deterministic rank; `dispatch` checks grants by the
    canonical action name; `payloadHash` normalises undefined fields.
18. MINOR (CR) MCP stdio test uses the schema option names and asserts a result.
19. MAJOR (CR) `/mama:configure` documents MAMA_DATABASE_PATH precedence.

Not taken: CR's migration 093 backfill change (an applied migration is not edited; whether its backfill
matched every row cannot be shown from source, and `~/.mama` is a disposable testbed).

## F4 — re-verification by Codex after F1–F3 (2026-09-27)

Codex re-read every item against the code: all F1–F3 defects resolved except these, fixed in one commit.

1. P1 F1.10: the target directory could be swapped for a symlink during the download await; the bytes
   are fetched first, then containment is rechecked and the file opened with no await in between.
2. P1 F1.18: a symlinked `workspace/files` moved the delivery boundary; the root must be a real directory.
3. P1 F3.11: MCP checkpoint saves bypassed the secret scan; core `saveCheckpoint` scans.
4. P1 F1.6 regression: one undeliverable recovered outbound entry blocked Telegram polling.
5. P2 F1.20 regression: a regenerated report hit a binding mismatch on its delivered key.
6. P2 F1.25 regression: an unavailable sibling attachment failed a valid download.
7. P2 F3.9: the recursive visibility CTE grew with reconverging paths; it recurses per edge with UNION.
8. P3 Trello: a board failing only on an invalid timestamp was not counted in the poll error.

## F5 — Codex review of the F4 commit (2026-09-27)

1. P1 The directory recheck still had a cross-process window before the open: the temp file is now
   opened empty and bytes are written only after the same device and inode are found under the
   rechecked directory; a failed rename removes the temp file.
2. P1 The checkpoint scan covers `recentConversation`, which checkpoint loading returns.
3. P2 Recovery no longer marks entries failed (that reset chunk progress on retry) and runs before polling
   again (it raced polling on processing entries); a failed entry is logged and polling still starts.
4. P2 A delivered key keeps its receipt only for the same destination; another chat still throws.
5. P2 Edge visibility is memoized per call; an edge met while being decided lies on a cycle and is
   invisible from any root, so the answers match the path-by-path evaluation.
   Also: the Chatwork poll error names failed/polled rooms and the last error, like Trello.

## F6 — Codex review of the F4 and F5 commits (2026-09-27)

1. P1 Repeated directory swaps across processes still beat the realpath and inode recheck; Node has no
   openat. The daemon now writes downloads only into daemon-owned `~/.mama/downloads/` (0700), which the
   agent can read but not write; the recheck code is deleted. The agent copies a download into
   workspace files to modify, unzip or deliver it.
2. P2 The delivered-receipt exception also answered file sends with another file's receipt; only the
   outbound text path opts in.
3. P2 (final pass) `agent.codex_cwd` could place the workspace at or around the downloads directory and
   make it agent-writable again; the daemon refuses overlapping paths at boot.
   Known limit: the check compares resolved paths, not realpaths, so a `codex_cwd` that is a symlink to
   the downloads directory passes; it is owner configuration, not agent-reachable.

## F7 — Opus and Codex reviews of the 2026-09-27 afternoon commits

Both reviews read `b3607ce3b..da11e0294`; every item was checked against the code, and the iCal item
against daemon.log.

1. P1 Related-work candidates were always empty: the host parsed the agent-facing pipeline, whose rows
   are positional arrays in seconds with no channel. The host reads open work from the snapshot.
2. P1 iCal failed every poll after its first snapshot (DTSTAMP is the fetch time, so the same sourceId
   carried a different payload). First-seen times are kept before poll returns; cancellations are
   versions; ended bookings are dropped.
3. P2 The 100-item pipeline cap would fail every delta and new session; removed.
4. P2 `source.recent.failedConnectors` read a table nothing wrote; poll outcomes are recorded.
5. P2 Board sections went stale (owner answers never published) or were replaced unread; a turn that
   changes work reads and updates the sections the item is in or leaves.
6. P2 The unused basis/freshness mechanism is removed.
7. P2 Wiki structure deleted with the delta-board turn is restored to the standing prompt.
8. P2 Cancelled iCal bookings stayed upcoming; all-day ends were judged in UTC; DURATION events failed
   the feed; upcoming events sorted as strings. Fixed with the owner timezone work.
9. P3 work.revise head read outside the transaction, report since-time, reminder calendar read,
   work.list limit, denial kind, inferred read window, search channel, feed-key validation, error text.

Not taken: slot compare-and-set for concurrent subagent board writes (board writes come from the owner
agent; no evidence of subagent board writes). Deferred as a known issue: collect-only intent of a first
snapshot is not persisted if the poll fails after saving.
