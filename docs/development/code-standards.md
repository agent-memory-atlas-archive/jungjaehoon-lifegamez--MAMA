# Code standards

Follow [AGENTS](../../AGENTS.md) and preserve the owner checks in [INTENT](../../INTENT.md).
Choose a mechanism because code, source data or an owner decision requires it.

## Keep ownership explicit

Core owns reusable storage, records, revisions, evidence, search and runtime mechanisms. Product
vocabulary and integration assembly belong to the consumer. Other projects import core through
its published exports, with their own database and authority. Verify this with the packed-core
check in [the intent workflow](intent-workflow.md).

Keep transport adapters thin. Read the assembly point before claiming a module is unused or an
action is unavailable. Prefer relocating proven mechanisms to duplicating or deleting them.
Before removing a host procedure or policy, identify where its domain knowledge and corrections
will reach the agent and confirm that path with a real owner turn.

The agent judges meaning, relevance, identity, roles and what to do. Host code supplies collection,
storage, search, execution, permissions and receipts. Do not turn uncertain interpretation into
keyword rules or introduce an alternate path just to hide a missing contract.

## Preserve contracts and errors

Use explicit types at boundaries and `unknown` for unvalidated input. The TypeScript ESLint rules
reject explicit `any`. Validate external values before using them and preserve structured error
codes through callers and traces. A legitimate empty result is different from failed retrieval;
do not substitute dummy data for an error.

Use the package's existing logging interface. Keep MCP stdout reserved for protocol traffic.
Log bounded operational evidence without tokens, configuration contents or private source text.
The root lint config does not ban every `console` call; choose the logger appropriate to the
runtime rather than inventing a repository-wide logging API.

Schema changes use the next-numbered migration in `packages/mama-core/db/migrations`. Never
reuse numbers 044–060; the retired migration chain already occupies them. Preserve old record
revisions and provenance while changing the current view. Record API, architecture and config
schema decisions through MAMA MCP `save`.

## Keep owner isolation intact

The owner runtime uses its workspace, a Git boundary, isolated plugin/settings sources and a
persistent backend session. Workspace writes, credential-read denies and secret-filtered backend
environments are part of the contract. Core's shell and web defaults remain off; standalone
explicitly enables the owner's tools. Do not widen these boundaries as a convenience fix.

The owner agent and its subagents retain ordinary work authority. The boundaries are non-owner
grants and scopes, configured delivery destinations, protected credentials, and administration
requiring an interactive owner request. Observe other work in tool traces. See
[backends](../guides/backends.md) and [security](../guides/security.md).

## Use the repository style

Prettier sets two spaces, single quotes, semicolons, ES5 trailing commas and a 100-character print
width. ESLint requires `const` where possible, braces and strict equality, and checks unused
variables. Run the configured tools instead of copying old style examples:

```bash
pnpm lint
pnpm format:check
```

The root format scripts cover package source and tests. Check documentation explicitly with
`pnpm exec prettier --check <changed-docs>` when needed.

Use descriptive names and comments that explain a constraint or decision. Keep modules cohesive;
line counts are a review signal, not proof of good boundaries. Count what a refactor removes as
well as what it adds. Add behaviour tests at the affected boundary and use neutral fixtures.

Do not commit personal or business identifiers, private source content or credentials in code,
comments, examples, fixtures or commit messages. Keep local `docs/superpowers/` artifacts out of
commits. Before reporting completion, inspect the diff and actual verification output.
