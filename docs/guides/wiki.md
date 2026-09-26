# Keep a readable work history

Ask MAMA to update the wiki when work changes, then inspect it in the viewer's Wiki
page or in a Markdown editor. The wiki organizes related knowledge; individual
task revisions remain in the work ledger.

## Choose the vault

Onboarding enables the wiki at `~/.mama/workspace/wiki`. To configure it manually:

```yaml
wiki:
  enabled: true
  vaultPath: ~/.mama/workspace
  wikiDir: wiki
```

A relative `wikiDir` is resolved under `vaultPath`; an absolute `wikiDir` names the
wiki root directly. Both paths are required when enabled. Restart after changing
configuration. The writer uses local Markdown files; opening them in Obsidian is
optional.

The owner agent's instructions use:

| Path                  | Content                                                               |
| --------------------- | --------------------------------------------------------------------- |
| `Home.md`             | Table of contents maintained by the agent                             |
| `daily/YYYY-MM-DD.md` | Dated journal: changed work, decisions, blockers and follow-up        |
| Topic pages           | History and current state for related, ongoing work                   |
| `lessons/`            | Reusable lessons, with process/system/client subdirectories available |

Directories are created at startup. Content and `Home.md` appear when the agent
publishes them; an empty vault is not a completed wiki.

## Read before changing a page

`manage.wiki.read` lists page paths or reads selected pages. Long lists and pages
are paginated; their version and continuation fields let the agent read the whole
result without combining different versions.

For an existing page, use `manage.wiki.update` to append to or replace a named
section, passing the `expectedContentVersion` returned by the read. A concurrent
change produces a conflict to resolve by reading again. Use
`manage.wiki.publish` for a new page with `expectedContentVersion: null`, or for a
version-checked publication of an existing page. Evidence belongs in `sourceIds`
and `sourceRefs`; visible prose should explain what happened without internal IDs.

The writer preserves an existing human section beginning with `<!-- human -->`.
Place manually maintained notes below that marker if they should survive agent
publication.

## Check what carried over

Pick a task that changed and compare its original messages, task revisions and
journal entry. The page should explain who did what, when it happened, the
feedback and what remains. Ask a later owner session to find that history and a
similar past case. A saved Markdown file alone does not demonstrate useful recall.
