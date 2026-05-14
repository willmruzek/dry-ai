# Effect Schema — patterns for agents

This project vendors **Effect** under `repos/effect/`. For authoritative API docs and the full combinator set, read `effect/Schema`, `effect/SchemaAST`, and `effect/ParseResult` in that tree (for example `packages/effect/src/Schema.ts`). The ideas below match how the Effect codebase defines, tests, and documents schemas (`packages/effect/schema-vs-zod.md`, `packages/effect/test/Schema/**`).

---

## Mental model: `Schema<A, I, R>`

- **`A` (Type)** — the _decoded_ / domain type you use in application code.
- **`I` (Encoded)** — the wire/input shape (often JSON-ish). For primitives, `A` and `I` are often the same.
- **`R` (Context)** — requirements for decoding/encoding (e.g. services when using `filterEffect`).

Naming follows **JSON-first**: transforms from non-JSON shapes usually say so (`NumberFromString`, `DateFromSelf`, …). See the “Naming Conventions” section in `repos/effect/packages/effect/schema-vs-zod.md`.

Infer types from a schema with **`typeof MySchema.Type`** (not a separate `infer` helper).

---

## Common constructors and combinators

| Pattern      | Typical API                                                                | Notes                                                  |
| ------------ | -------------------------------------------------------------------------- | ------------------------------------------------------ |
| Object       | `Schema.Struct({ ... })`                                                   | Readonly struct; field schemas describe each property. |
| Dictionary   | `Schema.Record({ key: KeySchema, value: ValueSchema })`                    | Key/value maps with schema for keys and values.        |
| Array        | `Schema.Array(element)`                                                    | Homogeneous lists.                                     |
| Tuple        | `Schema.Tuple(a, b, …)`                                                    | Fixed length, heterogeneous.                           |
| Optional     | `Schema.optional(schema)`, `Schema.optionalWith(schema, { as: "Option" })` | Default missing vs `Option` variants.                  |
| Nullable-ish | `Schema.NullOr`, `Schema.UndefinedOr`, `Schema.NullishOr`                  | Union with null/undefined.                             |
| Union        | `Schema.Union(a, b, …)`                                                    | Discriminated or general unions.                       |
| Literal      | `Schema.Literal("a", 1)`                                                   | Finite set of constants.                               |
| Enums        | `Schema.Enums({ ... })`                                                    | String/number enum objects.                            |
| Refinement   | `.pipe(Schema.filter(...))`, `Schema.minLength(n)`, etc.                   | Narrow type after a successful base parse.             |
| Brand        | `.pipe(Schema.brand("Name"))`                                              | Nominal typing on top of a base schema.                |
| JSON string  | `Schema.parseJson()`, `Schema.parseJson(innerSchema)`                      | Decode string → value; encode value → string.          |

**Pipe-style composition** is idiomatic: combinators are often written as `base.pipe(Schema.int(), Schema.brand("Int"))` (see `packages/effect/test/Schema/Schema/pipe.test.ts`).

---

## Encoding and decoding

Effect Schema is **bidirectional**: design schemas so you can round-trip to your wire format.

| Entry point             | Use when                                                     |
| ----------------------- | ------------------------------------------------------------ |
| `Schema.decodeUnknown*` | Input is `unknown` (API boundaries, CLI, JSON).              |
| `Schema.decode*`        | Input is already typed as the schema’s **encoded** `I`.      |
| `Schema.encodeUnknown*` | Output should match encoded shape; from unknown typed value. |
| `Schema.encode*`        | Value is typed as **decoded** `A`.                           |
| `Schema.validate*`      | Re-validate an existing `A`.                                 |

Variants:

- **`*Sync`** — throws `ParseError` on failure; must not require async (see below).
- **`*Either`** — returns `Either<ParseError, A>`; preferred for “parse, don’t throw” at boundaries.
- **`*Promise`** — async decoding/encoding.

**`unknown` vs typed decode** (from `schema-vs-zod.md`): treat untrusted input with `decodeUnknown*`; use `decode*` when the type system already guarantees the `I` shape.

```ts
import { Schema } from 'effect';

const User = Schema.Struct({
  username: Schema.String,
});

// Untrusted / external
Schema.decodeUnknownEither(User)(someUnknown);

// After User.Encoded is already established
Schema.decodeEither(User)(encodedUser);
```

---

## Transformation patterns

- **`Schema.transform`** — total decode/encode between `From` and `To` when conversion cannot fail in an interesting way.
- **`Schema.transformOrFail`** — decode/encode steps return `ParseResult` (can fail with structured issues).

Use transforms to **parse, don’t validate** (e.g. `Schema.URL`: string → `URL` instance), as described in `schema-vs-zod.md`.

**`Schema.parseJson(inner?)`** — parses a JSON string to `unknown` or to `inner`’s decoded type; encoding uses `JSON.stringify`. Cyclic structures fail on encode (see `packages/effect/test/Schema/Schema/parseJson.test.ts`).

---

## Error handling patterns

### Parse issues

`ParseResult` describes failures as a tree (`Type`, `Missing`, `Pointer`, `Transformation`, `Refinement`, `Composite`, …). See `packages/effect/src/ParseResult.ts`.

### Formatting for logs / users

- **`ParseResult.TreeFormatter.formatIssueSync(issue)`** — human-readable tree (sync path).
- **`ParseResult.TreeFormatter.formatIssue(issue)`** — returns an `Effect` when messages can be async (e.g. custom `message: () => Effect` annotations); use `Effect.runPromise` where tests do (`packages/effect/test/Schema/ParseResultFormatter.test.ts`).
- **`ParseResult.ArrayFormatter.formatIssueSync`** — collect multiple issues (often with `{ errors: "all", onExcessProperty: "error" }`).

### Either-based flow

```ts
import * as Either from 'effect/Either';
import * as ParseResult from 'effect/ParseResult';
import { Schema } from 'effect';

const result = Schema.decodeUnknownEither(MySchema)(input).pipe(
  Either.mapLeft((e) => ParseResult.TreeFormatter.formatIssueSync(e.issue)),
);
```

### Annotations

- **`Schema.annotations({ identifier: "MyType" })`** — improves error labels (see struct decoding tests in `packages/effect/test/Schema/Schema/Struct/Struct.test.ts`).
- **`message: () => string` (or Effect)** — custom failure text; async messages force async formatters.

### Parse options

Pass **parse options** (second argument) or attach defaults via **`schema.annotations({ parseOptions: { ... } })`**. Common knobs:

- **`onExcessProperty`**: `"ignore"` vs `"error"` for unknown keys on structs.
- **`errors`**: `"first"` vs `"all"`.

Example from `packages/effect/test/Schema/Schema/decodeEither.test.ts`: outer decode options can be overridden per call.

---

## Side effects and validation: `filterEffect`

When validation needs an **`Effect`** (DB lookup, clock, etc.), use **`Schema.filterEffect`** (built on **`transformOrFail`**). That introduces a **`R`** context on the schema; decode with `Effect` runners that provide those services, not only `decodeUnknownSync`.

---

## Examples adapted from the Effect repo

### Structs and missing keys (Effect tests)

From `packages/effect/test/Schema/Schema/Struct/Struct.test.ts`: a required field surfaces a path-specific `Missing` / type error:

```
{ readonly a: number }
└─ ["a"]
   └─ is missing
```

### pipe + brand + filters (Effect tests)

From `packages/effect/test/Schema/Schema/pipe.test.ts`:

```ts
import * as S from 'effect/Schema';

const int = <A extends number, I>(self: S.Schema<A, I>) =>
  self.pipe(S.int(), S.brand('Int'));

const positive = <A extends number, I>(self: S.Schema<A, I>) =>
  self.pipe(S.positive(), S.brand('Positive'));

const PositiveInt = S.NumberFromString.pipe(int, positive);
```

### parseJson failures (Effect tests)

From `packages/effect/test/Schema/Schema/parseJson.test.ts`: invalid JSON is reported as a **Transformation process failure** under `parseJson`, not a bare `SyntaxError`.

### URL: parse don’t validate (Effect docs)

From `schema-vs-zod.md` — invalid URL string throws a `ParseError` with a clear transformation message; valid input becomes a `URL` instance.

---

## What to avoid

- **`decodeUnknownSync` / `runSync` on schemas that need async work** — you get errors like “cannot be resolved synchronously” (`packages/effect/test/Schema/Schema/decodeEither.test.ts`, `encodeUnknownSync.test.ts`).
- **Treating Schema like Zod-only decode** — remember **encode** and round-trips; pick `*FromString` / `*FromSelf` names intentionally.
- **Ignoring excess keys** — for strict APIs, set `onExcessProperty: "error"` (tests rely on this for predictable failures).
- **Throwing in user code inside transforms** — prefer **`ParseResult.fail`** / **`transformOrFail`** so errors stay structured.
- **Relying on `z.infer`** — use **`typeof Schema.Type`** on the schema value.
- **Duplicating vendored Effect docs in this file** — treat `repos/effect` as source of truth; link mentally to `Schema.ts` and `schema-vs-zod.md` for tables and edge cases.

---

## Where to read next in `repos/effect`

| Area                       | Location                             |
| -------------------------- | ------------------------------------ |
| Public Schema surface      | `packages/effect/src/Schema.ts`      |
| AST / parse options        | `packages/effect/src/SchemaAST.ts`   |
| Error model & formatters   | `packages/effect/src/ParseResult.ts` |
| Zod comparison & tutorials | `packages/effect/schema-vs-zod.md`   |
| Behavior examples          | `packages/effect/test/Schema/**`     |
