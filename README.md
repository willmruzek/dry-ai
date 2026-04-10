# Share AI config CLI

Installs command, rule, and skill sources from `~/.config/agents` by default into Copilot and Cursor targets.

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

## Commands

```sh
saic install
saic skills list                                 List local skills
saic skills import [options] <repo> [skillPath]  Import a managed skill
saic skills remove <name>                        Remove a managed skill
saic skills update <name>                        Update a managed skill from its tracked source
saic skills update-all                           Update all managed skills from their tracked sources
```

`<repo>` may be a full git remote URL or a GitHub `owner/repo` shorthand such as `anthropics/skills`.

## Managed Skills

Imported skills are copied into `config/skills/<name>/` and tracked in `skills.lock.json`.

`skills import` derives `<name>` from the imported skill path by default. Use `--as <name>` to choose a different local managed skill name.

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

For development, use `pnpm dev` to rebuild into `dest/` on change and `pnpm dev:saic --test install` to run the built CLI.

Run `pnpm run setup:editor` after installing dependencies if you want the Effect language service workspace patch applied locally.

```sh
pnpm run setup:editor
pnpm run build
pnpm run dev
pnpm run test
pnpm run test:watch

pnpm dev:saic install
pnpm dev:saic --test install
pnpm dev:saic --output ./tmp/install-root install
pnpm dev:saic --input ./config install
```

## CI and Release

- On pull request open or update
  - Run CI validation with build, test, and `npm pack --dry-run`.
- On changes landing on `main`
  - Run the same CI validation with build, test, and `npm pack --dry-run`.
- On `v*` tag pushed to `main`
  - Verify the tag matches the checked-in `package.json` version.
  - Verify the tagged commit is on `main`.
  - Build and test the CLI.
  - Create a tarball with `npm pack`.
  - Create or update the matching GitHub Release.
  - Upload the tarball as a release asset.

Example release flow:

```sh
git tag v0.1.0
git push origin v0.1.0
```

Install from the release tarball with:

```sh
npm install -g https://github.com/willmruzek/share-ai-config/releases/download/v0.1.0/agents-installer-0.1.0.tgz
```
