# Effect Vitest (`@effect/vitest`) — patterns for agents

This project vendors Effect under `repos/effect/`. The Vitest integration package is at **`repos/effect/packages/vitest/`** (`README.md`, `src/index.ts`, `src/internal/internal.ts`, `src/utils.ts`, `test/`).

**Note:** The `dry-ai` repo may configure **plain `vitest`** today (`vitest.config.ts`). When you write **Effect-first** tests (or port suites), import **`it`** from **`@effect/vitest`** so tests get the right runtimes, layers, and `Expect` integration—not a bare `vitest` `it` wrapping `Effect.runPromise` by hand.

---

## Entrypoint: re-exported `vitest` + Effect helpers

From `packages/vitest/src/index.ts`:

- **`import { it, expect, describe, … } from "@effect/vitest"`** — **`export * from "vitest"`** plus an enhanced **`it`** (`Object.assign(V.it, { effect, live, scoped, scopedLive, flakyTest, layer, prop })`).
- **`addEqualityTesters()`** — registers a custom Vitest equality tester so **`expect(a).toEqual(b)`** respects **`Equal.equals`** for Effect data (`packages/vitest/src/internal/internal.ts`, tests in `test/equality-tester.test.ts`).
- **`makeMethods(customIt)`** / **`describeWrapped`** — build the same Effect-aware API off a different Vitest `it` (e.g. scoped fixtures).

Use **`expect` from `@effect/vitest`** in suites that rely on **`Data` / `Option` / `Either` / `Exit`** structural equality (`equality-tester.test.ts`).

---

## Test runners: `it.effect`, `it.live`, `it.scoped`, `it.scopedLive`

| API                 | Requirements `R`                       | When to use                                                                 |
| ------------------- | -------------------------------------- | --------------------------------------------------------------------------- |
| **`it.effect`**     | `TestServices` (default test services) | Normal Effect tests; **`TestClock`** etc.                                   |
| **`it.live`**       | `never` (live runtime)                 | Real clock, default logging behavior (`README.md`).                         |
| **`it.scoped`**     | Union of `TestServices` and `Scope`    | **`Effect.acquireRelease`**, `Effect.scoped`, anything needing **`Scope`**. |
| **`it.scopedLive`** | `Scope`                                | Scoped **and** live environment.                                            |

Handlers return **`Effect<A, E, R>`** matching that runner’s `R` (see `Vitest.TestFunction` in `index.ts`).

**From the README:** `it.effect` **suppresses** logs unless you **`Effect.provide(Logger.pretty)`** or use **`it.live`**.

---

## Common combinators on each runner

All runners expose the same Vitest-style helpers (`packages/vitest/src/internal/internal.ts`):

- **`.skip`**, **`.only`**, **`.skipIf` / `.runIf`**, **`.fails`**
- **`.each(cases)`** — table-style cases; the case value is the first argument to your test function (`test/index.test.ts`).

**`it.effect.fails`** — marks a test that is **intentionally** wrong until fixed (`README.md`).

Timeout / options: pass **`number`** or **`TestOptions`** as the last argument (forwarded to Vitest).

---

## Layer-backed suites: `layer`

**`layer(someLayer, options?)`** shares a **`Layer.toRuntime`** across tests, with **`beforeAll` / `afterAll`** wiring release (`internal.ts`).

- **`layer(Foo.Live)((it) => { it.effect(...); it.layer(Bar.Live)("nested", …) })`**
- Optional **name**: **`layer(Foo.Live)("suite name", (it) => …)`** → wraps in **`describe`**.
- **`it.layer(Inner.Live)`** nests merged layers; inner **`it.effect`** gets **`Foo + Bar`** (see docstring in `index.ts` and `test/index.test.ts`).
- **`excludeTestServices: true`** — do not merge default test env; use for “live” service behavior inside a layer (`test/index.test.ts` **`Sleeper` + Clock** example).

**Memo map** and **timeout** can be passed in the options bag (`index.ts`).

---

## Property-based tests: `it.prop` / `it.effect.prop`

- **`it.prop(name, arbitraries, (props, ctx) => boolean | void)`** — **synchronous** FastCheck; use **`Schema`** entries (wrapped with **`Arbitrary.make`**) or raw **`FastCheck`** arbitraries (`internal.ts` `prop` vs `makeTester` `prop`).
- **`it.effect.prop`** / **`it.scoped.prop`** — property **body returns `Effect`** (async properties under **`fc.asyncProperty`**).

Arbitraries:

- **Array form:** `[schemaA, fc.integer()]` → callback **`([a, b], ctx)`**
- **Record form:** `{ a: realNumber, b: fc.integer() }` → callback **`({ a, b }, ctx)`**

Pass **`fastCheck: { numRuns: … }`** via the options argument (`test/index.test.ts`).

---

## `it.flakyTest`

Wraps an **`Effect`** with **retry + elapsed cap** (default timeout **30s**, **`Schedule.recurs(10)`**, **`orDie`** on exhaustion) (`internal.ts`). Use **inside** an **`it.effect`** body when the **under-test** `Effect` is nondeterministic (`README.md` example with **`Random.nextBoolean`**).

---

## Assertion helpers: `utils.ts`

**`@effect/vitest`** also exports **`packages/vitest/src/utils.ts`** (e.g. **`assertLeft`**, **`assertRight`**, **`assertNone`**, **`assertSome`**, **`assertSuccess`**, **`assertFailure`**, **`deepStrictEqual`**, **`assertEquals`** using **`Equal.equals`**). Prefer these when you want **Cause / Either / Exit**-specific messages consistent with Effect’s equality.

---

## Error handling patterns

### Failures become thrown errors

`runPromise` joins a forked fiber; on failure it **`throw`**s the first **`Cause.prettyErrors`** entry and logs additional causes (`internal.ts`). So **`expect(() => …).toThrow`** is not the primary style—prefer **`Effect.exit`** / **`Either`** inside the test **`Effect`**.

### Asserting expected failures

**From `README.md`:**

```ts
it.effect('test failure as Exit', () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(divide(4, 0));
    expect(result).toStrictEqual(Exit.fail('Cannot divide by zero'));
  }),
);
```

Use **`Effect.flip`**, **`Effect.exit`**, or **`utils.assertLeft`** depending on the API under test.

### Cancellation / timeout

Tests run with Vitest’s **`ctx.signal`** passed into **`Effect.runPromise`** (`runPromise` in `internal.ts`). **`Fiber.interrupt`** is scheduled on **`ctx.onTestFinished`** so stray fibers are cleaned up. For timeout behavior, see **`it.scopedLive.fails`** in **`test/index.test.ts`**.

### Defects vs failures

**`it.flakyTest`** uses **`catchAllDefect`** before retry—**defects** are turned into **failures** for retry (`internal.ts`). Understand whether your flakiness is **`fail`** or **`die`** when choosing helpers.

---

## Examples adapted from the Effect codebase

### `it.effect` success (README)

```ts
import { it, expect } from '@effect/vitest';
import { Effect } from 'effect';

it.effect('test success', () =>
  Effect.gen(function* () {
    const result = yield* divide(4, 2);
    expect(result).toBe(2);
  }),
);
```

### `TestClock` vs `it.live` (README)

```ts
it.live('runs the test with the live Effect environment', () =>
  Effect.gen(function* () {
    yield* logNow; // real clock
  }),
);

it.effect('run the test with the test environment', () =>
  Effect.gen(function* () {
    yield* logNow; // TestClock at 0
  }),
);
```

### `it.scoped` for `acquireRelease` (README)

```ts
it.scoped('run with scope', () =>
  Effect.gen(function* () {
    yield* resource;
  }),
);
```

### Nested `layer` (index.ts docstring / tests)

```ts
layer(Foo.Live)('layer', (it) => {
  it.effect('adds context', () =>
    Effect.gen(function* () {
      const foo = yield* Foo;
      expect(foo).toEqual('foo');
    }),
  );

  it.layer(Bar.Live)('nested', (it) => {
    it.effect('adds context', () =>
      Effect.gen(function* () {
        const foo = yield* Foo;
        const bar = yield* Bar;
        expect(foo).toEqual('foo');
        expect(bar).toEqual('bar');
      }),
    );
  });
});
```

### `it.effect.prop` (tests)

```ts
const realNumber = Schema.Finite.pipe(Schema.nonNaN());

it.effect.prop('symmetry', [realNumber, FastCheck.integer()], ([a, b]) =>
  Effect.gen(function* () {
    return a + b === b + a;
  }),
);
```

---

## What to avoid

- **`it.effect`** for effects that need **`Scope`** but never use **`it.scoped`** / **`it.scopedLive`** — you’ll fight the type checker or leak resources.
- **`Effect.runPromise`** / **`runSync`** at the top level of a plain **`it("…", () => { … })`** — loses fiber interruption, test **`signal`**, and consistent error formatting; use **`it.effect`** (or **`it.live`**) instead.
- **Assuming logs appear** under **`it.effect`** — default test logging is quiet; **`Logger.pretty`** or **`it.live`** (`README.md`).
- **Ignoring `layer` lifecycle** — prefer **`layer(scopedLayer)`** for acquire/release assertions (see **`afterAll` + “released”** in **`test/index.test.ts`**).
- **`it.prop`** with an **`Effect`** body — use **`it.effect.prop`** (async property) instead.
- **Matchers that bypass `Equal`** for **`Option` / `Either` / `Exit`** — call **`addEqualityTesters()`** (or use **`@effect/vitest`** `expect`) so equality matches Effect’s **`Equal`** instances (`equality-tester.test.ts`).

---

## Where to read next in `repos/effect`

| Topic                 | Location                                                             |
| --------------------- | -------------------------------------------------------------------- |
| Public API            | `packages/vitest/src/index.ts`                                       |
| Runner implementation | `packages/vitest/src/internal/internal.ts`                           |
| Assertion helpers     | `packages/vitest/src/utils.ts`                                       |
| Tutorial              | `packages/vitest/README.md`                                          |
| Integration examples  | `packages/vitest/test/index.test.ts`, `test/equality-tester.test.ts` |
