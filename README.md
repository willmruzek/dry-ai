# Share AI config CLI

Installs command, rule, and skill sources from `~/.config/dryai` by default into Copilot and Cursor targets.

Pass `--input <path>` to read configs from a different root such as `./config`.

Pass `--output <path>` to write generated output somewhere other than your home directory.

`--test` is a shortcut for `--output ./output-test`, and if both are provided, `--output` wins.

## Input

Input config files live under the selected input root:

- `commands`
- `rules`
- `skills`

Live output is written to:

- `~/.copilot/prompts`
- `~/.copilot/instructions`
- `~/.copilot/skills`
- `~/.cursor/rules`
- `~/.cursor/skills`

## Example Configs

One input root can contain all three source types:

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

### Example Rule

Rules are markdown files under `rules/`. `dryai` recognizes these rule frontmatter fields:

- `description`
- `copilot.applyTo`
- `cursor.alwaysApply`
- `cursor.globs`

`cursor.globs` should be provided as one comma-separated glob string.

```md
---
description: Reply with "Yes, Captain!" before answering when the user says "Make it so" or "Engage".
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
- `cursor.disable-model-invocation`

```md
---
name: gen-commit-msg
description: Generate a conventional commit message from the current staged git diff.
cursor:
  disable-model-invocation: true
---

# Generate Commit Message

Read the staged diff and produce a conventional commit message with a concise subject and optional body.
```

### Example Skill

Skills live in directories under `skills/`. The directory is copied as-is into the Copilot and Cursor skills targets.

Unlike commands and rules, `dryai` does not define or validate a fixed skill frontmatter schema. Skill files are passed through unchanged, so the allowed frontmatter fields depend on the skill format expected by the target editor or agent.

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

## Commands

```sh
dryai install
dryai skills list                                 List local skills
dryai skills add [options] <repo>                 Add managed skills from a remote repository
dryai skills remove <name>                        Remove a managed skill
dryai skills update <name>                        Update a managed skill from its tracked source
dryai skills update-all                           Update all managed skills from their tracked sources
```

`<repo>` may be a full git remote URL or a GitHub `owner/repo` shorthand such as `anthropics/skills`.

## Managed Skills

Imported skills are copied into `config/skills/<name>/` and tracked in `skills.lock.json`.

`skills add` requires at least one `--skill <name>` value. Each requested skill is always resolved from `<repo root>/skills/<name>`.

Use `--as <name>` to choose a different local managed skill name when importing exactly one skill.

Examples:

```sh
dryai skills add anthropics/skills --skill skill-creator
dryai skills add vercel-labs/agent-skills --skill pr-review commit
dryai skills add https://github.com/vercel-labs/agent-skills.git --skill pr-review commit
```

By default, imports track the requested ref. With no `--ref`, that means the remote default branch `HEAD` is tracked. Use `--pin` to store the currently resolved commit instead, so later `skills update` operations stay pinned to that commit.

The lockfile records:

- the local skill name
- the source repository
- the source path within that repository
- the requested git ref, when one was provided
- the resolved commit that was imported

`skills update` and `skills update-all` re-fetch the tracked repository snapshot and replace the local copied skill directory.

`skills remove` deletes the local copied skill directory and removes its lockfile entry.

`skills list` reports local skill directories, annotating managed entries from the lockfile and flagging managed entries whose local directory is missing.

## Development

For development, use `pnpm dev` to rebuild into `dest/` on change and `pnpm dev:dryai --test install` to run the built CLI.

Run `pnpm run setup:editor` after installing dependencies if you want the Effect language service workspace patch applied locally.

```sh
pnpm run setup:editor
pnpm run build
pnpm run dev
pnpm run test
pnpm run test:watch

pnpm dev:dryai install
pnpm dev:dryai --test install
pnpm dev:dryai --output ./tmp/install-root install
pnpm dev:dryai --input ./config install
```

## CI and Release

- On pull request open or update
  - Run CI validation with build, test, and `npm pack --dry-run`.
- On changes landing on `main`
  - Run the same CI validation with build, test, and `npm pack --dry-run`.

- On `v*` tag pushed to `main`, the release workflow will:
  - Verify the tag matches the checked-in `package.json` version.
  - Verify the tagged commit is on `main`.
  - Build and test the CLI.
  - Create a tarball with `npm pack`.
  - Create or update the matching GitHub Release.
  - Upload the tarball as a release asset.
- After the release workflow succeeds, the publish workflow will:
  - Download the tarball artifact produced by the release workflow.
  - Publish that exact tarball to npm using npm trusted publishing.

Example release flow:

```sh
git tag v0.1.0
git push origin v0.1.0
```

Install from the release tarball with:

```sh
npm install -g https://github.com/willmruzek/share-ai-config/releases/download/v0.1.0/share-ai-config-0.1.0.tgz
```
