# Share AI config CLI

Syncs rules, commands, and skills from `~/.config/dry-ai` into supported agent targets (currently Copilot and Cursor).

**Compared to [skills.sh](https://skills.sh):** with `dry-ai skills add`, you can **edit those files**, and the CLI will not override them on the next `sync` run. This allows you to use existing skills, tailor them to your needs, and keep track of their original sources.

Global CLI options:

- `--config-root <path>` reads configs from a different root such as `./config`.
- `--output-root <path>` writes generated output somewhere other than your home directory.
- `--test` is a shortcut for `--output-root ./output-test`, and if both are provided, `--output-root` wins.

These are root-level options for the CLI. They modify command behavior for any given command.

## Config Layout

Input config files live under the selected config root:

- `commands`
- `rules`
- `skills`

`dry-ai` will output these sources into:

- `~/.copilot/prompts`
- `~/.copilot/instructions`
- `~/.copilot/skills`
- `~/.cursor/rules`
- `~/.cursor/skills`

A config root contains all three source types:

```text
~/.config/dry-ai/
├── commands/
│   └── gen-commit-msg.md
├── rules/
│   └── say-yes-captain.md
└── skills/
    └── review-helper/
        └── SKILL.md
```

## Commands

### `sync`

#### Name

`dry-ai sync` — copy commands, rules, and skills from the config root into supported agent output trees.

#### Description

`sync` reads `commands`, `rules`, and `skills` under the active config root and updates Copilot and Cursor targets under the output root. It maintains `sync-manifest.json` next to the config root: a record of what dry-ai generated so a later run can remove obsolete outputs when you change or delete sources, summarize what changed, and leave alone anything dry-ai did not create.

### `skills add`

#### Name

`dry-ai skills add` — import one or more managed skills from a remote git repository into the active config root.

#### Synopsis

```text
dry-ai [global options] skills add <repo> --skill <name> [<name> ...] [import options]
```

`<repo>` is either a full git remote URL or a GitHub `owner/repo` shorthand (for example, `anthropics/skills`).

#### Description

Copies each requested skill into `skills/<name>/` under the config root and records it in `skills.lock.json` (along with source repo, path, ref, resolved commit, and content hashes). Local skill trees and the lockfile always use the selected `--config-root` (default: `~/.config/dry-ai`).

By default each skill name is resolved from `<repo root>/skills/<name>/`. Use `--path` to use another directory inside the repo, or `--path .` to use the repository root.

#### Options

- **`--skill <name> [<name> ...]`** — Required at least once. Put every skill to import after the first `--skill` token (variadic), or use `--skill` again for another group (for example `--skill a --skill b`). Duplicate names in one run are ignored.
- **`--path <repoPath>`** — Base directory inside `<repo>` for resolving skills (instead of `skills/`).
- **`--path .`** — Resolve each skill from the repository root.
- **`--as <name>`** — Store the imported skill under a different local name (only when importing exactly one skill).
- **`--ref <gitRef>`** — Fetch a specific branch, tag, or commit instead of the remote default.
- **`--pin`** — Record the resolved commit so the lockfile does not follow a moving branch ref.

#### Examples

```sh
# Resolves from <repo root>/skills/skill-creator
dry-ai skills add anthropics/skills --skill skill-creator

# Resolves from <repo root>/review-helper
dry-ai skills add anthropics/skills --path . --skill review-helper

# Resolves from <repo root>/tools/review-helper
dry-ai skills add anthropics/skills --path tools --skill review-helper

# Resolves from <repo root>/skills/pr-review and <repo root>/skills/commit
dry-ai skills add vercel-labs/agent-skills --skill pr-review commit

# Same as above; repeated --skill is equivalent to one variadic --skill
dry-ai skills add vercel-labs/agent-skills --skill pr-review --skill commit

# Resolves from <repo root>/skills/pr-review and <repo root>/skills/commit
dry-ai skills add https://github.com/vercel-labs/agent-skills.git --skill pr-review commit
```

By default, imports track the requested ref. With no `--ref`, that means the remote default branch `HEAD` is tracked.

### `skills update`

#### Name

`dry-ai skills update` — re-fetch one managed skill from its tracked source and replace the local directory under the config root.

#### Synopsis

```text
dry-ai [global options] skills update <name> [--force]
```

#### Description

Uses `skills.lock.json` to find the skill’s remote and ref, fetches the same layout as at import time, and replaces files when the working tree still matches the lockfile hashes. If local files were added, removed, or edited, the update is skipped unless **`--force`** is set (see **`skills` lockfile** below).

#### Options

- **`--force`** — Overwrite local edits with the fetched remote copy and refresh hashes in `skills.lock.json`.

### `skills update-all`

#### Name

`dry-ai skills update-all` — re-fetch every managed skill and replace each local copy in turn.

#### Synopsis

```text
dry-ai [global options] skills update-all [--force]
```

#### Description

Runs the same hash-guarded update logic as **`skills update`**, once per lockfile entry. Skills with local drift are skipped unless **`--force`** is passed.

#### Options

- **`--force`** — Overwrite local edits for any skill where the remote copy would otherwise be skipped.

### `skills remove`

#### Name

`dry-ai skills remove` — delete a managed skill’s local directory and drop its row from `skills.lock.json`.

#### Synopsis

```text
dry-ai [global options] skills remove <name>
```

#### Description

`<name>` is the managed skill name (the directory name under `skills/` in the config root).

### `skills list`

#### Name

`dry-ai skills list` — show local skill directories and how they relate to the lockfile.

#### Synopsis

```text
dry-ai [global options] skills list
```

#### Description

Lists directories under `skills/` in the config root. Managed skills include a summary from the lockfile; unmanaged entries are labeled as such. Lockfile rows that no longer have a local directory are reported so you can spot a broken or removed tree.

## Example Configs

### Example Rule

Rules are markdown files under `rules/`. Required top-level fields are validated (`description`, etc.). Under `agents`, each agent's block must be a YAML mapping when present; all keys in that mapping are copied into that agent's generated file (after stripping `undefined` values). Dry-ai does not infer Cursor fields from Copilot fields or vice versa.

Common keys:

- `agents.copilot.applyTo` (Copilot instructions)
- `agents.cursor.alwaysApply`, `agents.cursor.globs` (Cursor rules)

```md
---
description: Reply with "Yes, Captain!" before answering when the user says "Make it so" or "Engage".
agents:
  copilot:
    applyTo: '**/*.tsx, **/*.ts, src/**/*.ts, src/**/*.tsx, src/**/*.js, src/**/*.jsx'
  cursor:
    alwaysApply: false
    globs: '**/*.tsx, **/*.ts, src/**/*.ts, src/**/*.tsx, src/**/*.js, src/**/*.jsx'
---

# Say Yes Captain

When the user says "Make it so" or "Engage", start your response with "Yes, Captain!".
```

### Example Command

Commands are markdown files under `commands/`. `dry-ai` recognizes these command frontmatter fields:

- `name`
- `description`
- `agents.cursor.disable-model-invocation`

```md
---
name: gen-commit-msg
description: Generate a conventional commit message from the current staged git diff.
agents:
  cursor:
    disable-model-invocation: true
---

# Generate Commit Message

Read the staged diff and produce a conventional commit message with a concise subject and optional body.
```

### Example Skill

Skills live in directories under `skills/`. The directory is copied as-is into the configured agent skill targets.

Unlike commands and rules, `dry-ai` does not define or validate a fixed skill frontmatter schema. Skill files are passed through unchanged, so the allowed frontmatter fields depend on the skill format expected by the target agent.

```text
skills/
└── review-helper/
    └── SKILL.md
```

```md
---
name: review-helper
description: Use this skill when the user asks for a code review, PR review, or wants bugs and risks called out first.
---

# Review Helper

Focus on findings first.

- Identify bugs, regressions, and missing tests before summarizing.
- Keep the overview brief unless the user asks for a deeper walkthrough.
```

## Development

For development, use `pnpm dev` to rebuild into `dest/` on change and `pnpm dev:dry-ai <...>` to run the built CLI.

To put this checkout’s CLI on your PATH as `dry-ai`, run **`pnpm link --global`** from the repo root after a build (or **`npm link`** with npm’s global link workflow). Use **`pnpm unlink --global`** / **`npm unlink -g dry-ai`** when you want to stop using the linked binary.

Run `pnpm run setup:editor` after installing dependencies if you want the Effect language service workspace patch applied locally.

```sh
pnpm run setup:editor
pnpm run build
pnpm run dev
pnpm run test
pnpm run test:watch

pnpm dev:dry-ai <...>
```

---

## VS Code Setup

VS Code does not automatically discover prompt (command) files from the Copilot prompt target at `~/.copilot/prompts`.

Add this to your VS Code user settings if you want prompt files installed by `dry-ai` into that target to be picked up:

```json
{
  "chat.promptFilesLocations": {
    "~/.copilot/prompts": true
  }
}
```
