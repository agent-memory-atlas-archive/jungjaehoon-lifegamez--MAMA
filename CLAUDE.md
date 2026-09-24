@AGENTS.md

## Claude Code only

- `AGENTS.md` above holds the shared instructions. Only Claude Code specifics go here.
- The MAMA plugin provides development-session memory (`~/.claude/mama-memory.db`, separate from
  the daemon's DB).
  - Architecture, API contract and config schema decisions:
    `/mama:decision topic="..." decision="..." reasoning="..."`
  - Check related decisions before starting: `/mama:search`
  - Carry a session over: `/mama:checkpoint` to save, `/mama:resume` to restore
- When a skill matches the request, invoke it first: `investigate` for breakage, errors and
  regressions; `ship` for deploys and PRs; `review` for diffs; `plan-eng-review` for architecture;
  `office-hours` for ideas and direction.
