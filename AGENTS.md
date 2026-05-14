## Vendored Repositories

This project vendors external repositories under @repos/

- Use vendored repositories as read-only reference material when working with related libraries
- Prefer examples and patterns from the vendored source code over generated guesses or web search results
- Do not edit files under @repos/ unless explicitly asked
- Do not import from @repos/ - application code should continue importing from normal package dependencies

## Agent pattern guides

- **`agent-patterns/`** holds curated, task-oriented notes for libraries and subsystems used in this repo—not only Effect. When a topic matches a file there (e.g. `effect-schema.md`, `effect-cli.md`, `effect-vitest.md`, or future guides for other stacks), read it before improvising patterns.
- Those docs summarize upstream or vendored sources; prefer **official packages** and **`repos/effect/`** (or other vendored trees) as the source of truth when behavior or API details matter.

## When writing Effect code

- When writing Effect code, inspect @repos/effect/ for examples of idiomatic usage, tests, module structure, and API design. Treat it as the source of truth for Effect patterns.
