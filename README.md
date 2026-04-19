# Share AI config CLI

Syncs command, rule, and skill sources from `~/.config/dryai` by default into supported agent targets.

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

The current built-in agent config writes live output to these default roots:

- `~/.copilot/prompts`
- `~/.copilot/instructions`
- `~/.copilot/skills`
- `~/.cursor/rules`
- `~/.cursor/skills`

One config root can contain all three source types:

```text
~/.config/dryai/
├── commands/
│   └── gen-commit-msg.md
├── rules/
│   └── say-yes-captain.md
└── skills/
    └── review-helper/
        └── SKILL.md
```

See VS Code editor setup note below.

## Commands

### `sync`

- Purpose: Sync commands, rules, and skills from the selected config root into the configured agent target directories.
- Input roots: Reads from `commands`, `rules`, and `skills` under the selected config root.
- Output roots: Writes to the live output paths listed in Config Layout by default.
- Pruning: Removes stale dryai-managed outputs that were written by earlier sync runs but are no longer present in the selected config root.
- Safety: Only prunes outputs tracked in `sync-manifest.json`; unrelated user files in target roots are left alone.

### `skills add`

- Purpose: Import one or more managed skills from a remote repository.
- Repository argument: `<repo>` may be a full git remote URL or a GitHub `owner/repo` shorthand such as `anthropics/skills`.
- Storage: Imported skills are copied into `config/skills/<name>/` and tracked in `skills.lock.json`.
- Config root: Local skill directories and `skills.lock.json` are read from and written to the selected config root.
- Required: `--skill <name>` is required at least once.
- Default resolution: Each requested skill resolves from `<repo root>/skills/<name>`.
- `--path <repoPath>`: Resolves each requested skill from a different base directory.
- `--path .`: Resolves each requested skill from the repository root itself.
- `--as <name>`: Stores the imported skill under a different local managed name when importing exactly one skill.
- `--ref <gitRef>`: Fetches a specific branch, tag, or commit instead of the remote default branch.
- `--pin`: Stores the resolved commit instead of tracking a moving ref.
- Examples:

```sh
# Resolves from <repo root>/skills/skill-creator
dryai skills add anthropics/skills --skill skill-creator

# Resolves from <repo root>/review-helper
dryai skills add anthropics/skills --path . --skill review-helper

# Resolves from <repo root>/tools/review-helper
dryai skills add anthropics/skills --path tools --skill review-helper

# Resolves from <repo root>/skills/pr-review and <repo root>/skills/commit
dryai skills add vercel-labs/agent-skills --skill pr-review commit

# Resolves from <repo root>/skills/pr-review and <repo root>/skills/commit
dryai skills add https://github.com/vercel-labs/agent-skills.git --skill pr-review commit
```

By default, imports track the requested ref. With no `--ref`, that means the remote default branch `HEAD` is tracked.

### `skills update`

- Purpose: Re-fetch one managed skill from its tracked source and replace the local copied directory.
- `--force`: Overwrites local edits instead of skipping the update.

### `skills update-all`

- Purpose: Re-fetch all managed skills from their tracked sources and replace the local copied directories.
- `--force`: Overwrites local edits instead of skipping the update.

### `skills rehash`

- Purpose: Refresh the stored file hashes for one managed skill using its current local contents.

### `skills rehash-all`

- Purpose: Refresh the stored file hashes for every managed skill using their current local contents.
- Behavior: Skips managed entries whose local directory is missing.

### `skills remove`

- Purpose: Delete a managed skill's local copied directory and remove its lockfile entry.

### `skills list`

- Purpose: Report local skill directories, annotate managed entries from the lockfile, and flag managed entries whose local directory is missing.

### `skills` lockfile

The lockfile records:

- the local skill name
- the source repository
- the source path within that repository
- the requested git ref, when one was provided
- the resolved commit that was imported
- the last installed content hash for each file in the managed skill directory

Before replacing a managed skill, `dryai` compares the current local files against the hashes stored in `skills.lock.json`. If any file was added, removed, or edited locally, the update is skipped and a warning is printed so you do not lose your customizations by accident.

For skills imported before hash tracking existed, use these commands to store hashes from the current local directory without fetching from the remote source:

```sh
dryai skills rehash review-helper
dryai skills rehash-all
```

Use these commands to intentionally overwrite local edits:

```sh
dryai skills update review-helper --force
dryai skills update-all --force
```

## Example Configs

### Example Rule

Rules are markdown files under `rules/`. `dryai` recognizes these rule frontmatter fields:

- `description`
- `agents.copilot.applyTo`
- `agents.cursor.alwaysApply`
- `agents.cursor.globs`

`agents.cursor.globs` should be provided as one comma-separated glob string.

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

Commands are markdown files under `commands/`. `dryai` recognizes these command frontmatter fields:

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

Unlike commands and rules, `dryai` does not define or validate a fixed skill frontmatter schema. Skill files are passed through unchanged, so the allowed frontmatter fields depend on the skill format expected by the target agent.

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

For development, use `pnpm dev` to rebuild into `dest/` on change and `pnpm dev:dryai <...>` to run the built CLI.

Run `pnpm run setup:editor` after installing dependencies if you want the Effect language service workspace patch applied locally.

```sh
pnpm run setup:editor
pnpm run build
pnpm run dev
pnpm run test
pnpm run test:watch

pnpm dev:dryai <...>
```

---

## VS Code Setup

One current editor-specific note: VS Code does not automatically discover prompt files from the Copilot prompt target at `~/.copilot/prompts`.

Add this to your VS Code user settings if you want prompt files installed by `dryai` into that target to be picked up:

```json
{
  "chat.promptFilesLocations": {
    "~/.copilot/prompts": true
  }
}
```
