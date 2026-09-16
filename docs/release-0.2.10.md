# Tracing 0.2.10: idempotent delivery

## Problem and change

Version 0.2.9 could create another trace and another set of billable generations when
Langfuse accepted an upload but the local acknowledgement was lost. The existing
turn ledger only prevented retries after a successful local commit. Explicit trace
seeds stabilized the trace ID but still left observation IDs random.

Version 0.2.10 derives stable trace, root, generation, and tool IDs from native
session, turn, response, and tool-call identities. It uses the OpenTelemetry ID
generator extension point so roots remain actual roots with trace input/output.
The upload ledger, byte checkpoints, and explicit trace-seed contract are retained.
Legacy generations without response IDs use their position within the turn.

## Validation on 2026-09-16

- Four retry regressions failed against the previous implementation.
- Full suite: 107 passed, one optional stress test skipped.
- TypeScript, Prettier, distribution build, and whitespace checks passed.
- Langfuse synthetic ingestion: the same 17 native response fixtures were uploaded
  from four independent local ledgers. The server retained one trace, 17 generations,
  and the same USD 0.0006528 reference cost.
- Each observation's updated timestamp advanced on both final replays, confirming
  that the server processed the retries; observation IDs and costs stayed unchanged.
- Trace input/output remained populated; the root had no synthetic parent.
- Seeded retries, seed derivation failure, copied rollouts, nested subagents, and
  concurrent session isolation are covered by automated tests.

The live fixture uses the release-validation environment and tags. It did not call
a model provider. Existing production conversations and upload ledgers were not
replayed or changed.

## Rollout boundary

The protection applies to clients running 0.2.10. Existing records created with
older random IDs are not rewritten or deleted. An ambiguous upload crossing an
old-to-new version boundary can still have a historical random-ID counterpart.
This release does not implement automatic price initialization for new projects.
