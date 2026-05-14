# Effect CLI (`@effect/cli`) — patterns for agents

This project vendors Effect under `repos/effect/`. The CLI package lives at `repos/effect/packages/cli/` (`README.md`, `src/`, `examples/`, `test/`). Use that tree as the source of truth; this note captures the shapes that show up in real Effect apps.

**Note:** This repository’s shipped CLI (`dry-ai`) may use other libraries (e.g. Commander) for historical reasons. When you add or port **Effect-native** CLI code, follow `@effect/cli` patterns below—not a mix of frameworks in the same entrypoint without a clear boundary.

---

## Core model: `Command<Name, R, E, A>`

From `packages/cli/src/Command.ts` and the package README:

- **`Name`** — command identifier string.
- **`R`** — handler **requirements** (services the `Effect` needs).
- **`E`** — handler **failures** (your domain errors).
- **`A`** — **parsed configuration**: the object built from the command’s `Args`, `Options`, and nested config (see `Command.Config` / `ParseConfig`).

Handlers are **`Effect<void, E, R>`**. Parsing and built-ins produce **`ValidationError`** on a **separate channel** when you run the CLI (see Error handling).

---

## Common constructors and combinators

### Commands

| Pattern          | API                                                                                               | Notes                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Define a command | `Command.make(name, config?, handler?)`                                                           | `config` keys become fields on `A`; values are `Options` / `Args` / nested objects / arrays of those. |
| Subcommands      | `parent.pipe(Command.withSubcommands([child1, child2]))`                                          | Children are full `Command`s; see `examples/minigit.ts` and `test/Command.test.ts`.                   |
| Deferred handler | `Command.make("x", cfg).pipe(Command.withHandler(({ ... }) => Effect))`                           | Same as passing `handler` to `make`; useful when layering `provide*` after.                           |
| Description      | `Command.withDescription("…")`                                                                    | Help text.                                                                                            |
| Inject services  | `Command.provide`, `Command.provideEffect`, `Command.provideEffectDiscard`, `Command.provideSync` | Narrow `R` by satisfying a `Tag` or running setup before the handler.                                 |
| Wrap handler     | `Command.transformHandler`                                                                        | Adjust the effect returned by the handler (logging, timing, etc.).                                    |
| Runnable CLI     | `Command.run(command, { name, version, … })`                                                      | Returns **`(args: string[]) => Effect<…>`** — typical entry is `cli(process.argv)`.                   |
| Wizard / prompts | `Command.prompt`, `Command.wizard`                                                                | Interactive flows; needs `Terminal` etc.                                                              |

### Options (flags)

From `packages/cli/src/Options.ts` — all are **`Options<A>`** and support **`.pipe(...)`**:

- **Constructors:** `Options.boolean`, `Options.text`, `Options.integer`, `Options.choice`, `Options.keyValueMap`, `file` / path helpers, redacted/secret variants, etc.
- **Common pipes:** `Options.optional`, `Options.withAlias("v")`, `Options.withFallbackConfig(Config.boolean("ENV_KEY"))` (see `examples/minigit.ts` for `VERBOSE` / `DEPTH`).
- **Combine:** `Options.all({ a: optA, b: optB })` (and tuple/iterable overloads) to build a single options value.

### Args (positional)

From `packages/cli/src/Args.ts`:

- **Constructors:** `Args.text({ name: "repository" })`, `Args.directory()`, etc.
- **Variadic:** `Args.text({ name: "pathspec" }).pipe(Args.repeated)` (`minigit.ts`).
- **Optional args:** `Args.directory().pipe(Args.optional)`.
- **Defaults from env/config:** `Args.withFallbackConfig` (see `test/Command.test.ts` clone `REPOSITORY`).

### Parent config in subcommands

Subcommand handlers can read **parent** parsed config by **`yield* parentCommand`** inside `Effect.gen` (the parent `Command` is in context). Example from `packages/cli/test/Command.test.ts`: `clone` uses `yield* git` to read `verbose` defined on the top-level `git` command.

---

## Running the app: `CliApp` and platform

- **`Command.run`** builds a function `args => Effect<void, E | ValidationError, R | CliApp.Environment>`.
- **`CliApp.Environment`** = **`FileSystem | Path | Terminal`** (`packages/cli/src/CliApp.ts`).
- On **Node**, documentation and examples use **`NodeContext.layer`** from `@effect/platform-node` and **`NodeRuntime.runMain`** (see `packages/cli/README.md` “Configure Your Application” and `examples/minigit.ts`).

```ts
import { Command } from '@effect/cli';
import { NodeContext, NodeRuntime } from '@effect/platform-node';
import { Effect } from 'effect';

const command = Command.make(
  'app',
  {
    /* … */
  },
  () => Effect.void,
);

const cli = Command.run(command, {
  name: 'My CLI',
  version: '1.0.0',
});

Effect.suspend(() => cli(process.argv)).pipe(
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain,
);
```

---

## Error handling patterns

### `ValidationError` (parse / usage)

Parsing argv produces **`ValidationError`**, modeled as a **tagged union** with an **`error: HelpDoc`** (and sometimes extra fields). See `packages/cli/src/ValidationError.ts`:

- **`InvalidValue`**, **`InvalidArgument`**, **`MissingValue`**, **`MissingFlag`**, **`MissingSubcommand`**, **`CommandMismatch`**, **`HelpRequested`**, **`CorrectedFlag`**, etc.
- Use **`ValidationError.isValidationError`**, **`ValidationError.isHelpRequested`**, and other guards when discriminating.

`CliApp`’s internal runner **prints** the `HelpDoc` for failures and **fails** with the structured error (`packages/cli/src/internal/cliApp.ts`).

### Tests: expecting a parse failure

From `packages/cli/test/CliApp.test.ts`:

```ts
import * as HelpDoc from '@effect/cli/HelpDoc';
import * as ValidationError from '@effect/cli/ValidationError';
import { Effect } from 'effect';

const result = yield * Effect.flip(cli(args));
expect(result).toEqual(
  ValidationError.invalidValue(HelpDoc.p("Received unknown argument: '--bar'")),
);
```

Use **`Effect.flip`** when you expect **`ValidationError`** (or any failure) from the CLI effect.

### Handler errors vs validation errors

- **`E`** — your command’s **`Effect.fail`** / typed defects: compose with `ValidationError` in the **`run`** effect’s error channel as **`E | ValidationError`**.
- Do not conflate “bad user input” (usually **`ValidationError`**) with “operation failed after parse” (`E`), so help and logging stay consistent.

### Configuration: `CliConfig`

`CliConfig.layer({ showBuiltIns: false })` etc. changes help output and built-in behavior (`CliApp.test.ts`). Default built-ins include **`--help`**, **`--version`**, **`--log-level`**, **`--completions`**, **`--wizard`** (`packages/cli/README.md`).

---

## Examples adapted from the Effect codebase

### Mini-git style (options + repeated args + subcommands)

From `packages/cli/examples/minigit.ts`:

```ts
import { Args, Command, Options } from '@effect/cli';
import { Array, Config, Console, Option } from 'effect';

const configs = Options.keyValueMap('c').pipe(Options.optional);
const minigit = Command.make('minigit', { configs }, ({ configs }) =>
  Option.match(configs, {
    onNone: () => Console.log("Running 'minigit'"),
    onSome: (configs) => {
      /* print map */
    },
  }),
);

const pathspec = Args.text({ name: 'pathspec' }).pipe(Args.repeated);
const verbose = Options.boolean('verbose').pipe(
  Options.withAlias('v'),
  Options.withFallbackConfig(Config.boolean('VERBOSE')),
);
const minigitAdd = Command.make(
  'add',
  { pathspec, verbose },
  ({ pathspec, verbose }) => Console.log(/* … */),
);

// … plus other subcommands; then:
// const command = minigit.pipe(Command.withSubcommands([minigitAdd, …]))
```

### Parent context + `provideEffect` (git-style test)

From `packages/cli/test/Command.test.ts` (shortened; see file for full `clone` / `Messages` setup): top-level `git` holds `verbose`; `add` provides `AddService` and reads `yield* git` for parent flags.

```ts
const git = Command.make('git', {
  verbose: Options.boolean('verbose').pipe(
    Options.withAlias('v'),
    Options.withFallbackConfig(Config.boolean('VERBOSE')),
  ),
}).pipe(
  Command.provideEffectDiscard(() =>
    Effect.flatMap(Messages, (_) => _.log('shared')),
  ),
);

const add = Command.make('add', {
  pathspec: Args.text({ name: 'pathspec' }),
}).pipe(
  Command.withHandler(({ pathspec }) =>
    Effect.gen(function* () {
      yield* AddService;
      const { verbose } = yield* git;
      /* … */
    }),
  ),
  Command.provideEffect(AddService, (_) =>
    Effect.succeed('AddService' as const),
  ),
);

const run = git.pipe(
  Command.withSubcommands([clone, add]), // `clone` omitted here — see test file
  Command.run({ name: 'git', version: '1.0.0' }),
);
```

---

## What to avoid

- **Omitting platform `Layer`s** — `FileSystem`, `Path`, and `Terminal` must be available for **`CliApp.run`** / **`Command.run`** effects on Node/Bun.
- **Ignoring `ValidationError` in types** — the runnable CLI effect fails with **`ValidationError`** for user errors; don’t assume only your `E`.
- **Hand-rolling argv instead of `@effect/cli`** — you lose help, completions, wizard, and consistent **`HelpDoc`** errors.
- **Subcommand configs that don’t match usage** — excess argv becomes **`invalidValue`** / similar (`CliApp.test.ts`); design `Args`/`Options` to consume or explicitly allow leftovers via API choices.
- **Documenting env-based defaults without wiring `Config`** — use **`Options.withFallbackConfig` / `Args.withFallbackConfig`** so behavior matches docs (`minigit.ts`, `Command.test.ts`).

---

## Where to read next in `repos/effect`

| Topic                | Location                                 |
| -------------------- | ---------------------------------------- |
| Module exports       | `packages/cli/src/index.ts`              |
| Command API          | `packages/cli/src/Command.ts`            |
| Options / Args       | `packages/cli/src/Options.ts`, `Args.ts` |
| Validation errors    | `packages/cli/src/ValidationError.ts`    |
| Run / print help     | `packages/cli/src/internal/cliApp.ts`    |
| Tutorial & built-ins | `packages/cli/README.md`                 |
| Runnable examples    | `packages/cli/examples/*.ts`             |
| Behavior tests       | `packages/cli/test/*.test.ts`            |
