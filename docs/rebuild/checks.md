# Rebuild check log

One entry per work item: result, evidence, what still fails. 3-5 lines each.

## W0 — 2026-09-25

- Result: met for W0's own check. No owner check (C1–C6) is claimed.
- Evidence (supervisor, outside the sandbox, uncached): root build and typecheck pass; core 112 files/825
  tests, MCP server 13/121 (14 skipped), plugin 11/165, standalone stub 0 tests. The first uncached run
  failed 24 core tests on a half-downloaded embedding model after the reinstall; they pass once the
  model finished downloading.
- Migrations 081–095 applied to a `VACUUM INTO` copy of the dev memory DB: schema 080 → 095, 1,279 decisions
  kept, integrity ok. The original was only read.
- Still open: release/publish jobs would publish the stub standalone if a release tag is pushed. The daemon
  is stopped until the W1 cutover.
