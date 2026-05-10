Feature: dry-ai sync
  # As a dry-ai user
  # I want to run `dry-ai sync` against commands, rules, and skills
  # So that Copilot and Cursor outputs under the output root reflect the configuration sources

  # Background:
  #   Given the dry-ai sync Vitest suite with an in-memory Effect FileSystem mock, glob, and os.homedir
  #   And stdout and stderr are captured for assertions
  #   And a virtual configuration root with commands/, rules/, and skills/ directories
  #   And a virtual home directory is used as the default agent output root

  Rule: Sync workflows keep agent outputs, manifest, and report aligned

    Scenario: Sync a valid config into every supported agent
      Given I have added one command, one rule, and one skill to the config root
      When I run `dry-ai sync`
      Then dry-ai outputs the expected command, rule, and skill for every supported agent
      And generates command and rule files with expected frontmatter and body
      And records every managed output in sync-manifest.json
      And installs outputs by agent and kind in the report

    Scenario: Sync again after changing sources
      Given I have already run `dry-ai sync` for command, rule, and skill outputs
      When I update command, rule, and skill sources
      And I run `dry-ai sync` again
      Then dry-ai updates affected agent outputs from the changed sources
      And keeps sync-manifest.json aligned with managed outputs
      And lists updated outputs in the report

    Scenario: Sync again after deleting sources
      Given I have already run `dry-ai sync` for command, rule, and skill outputs
      When I delete a command source and a skill source folder
      And I run `dry-ai sync` again
      Then dry-ai removes managed outputs for deleted sources
      And keeps unrelated outputs managed
      And removes deleted sources from sync-manifest.json
      And lists removed outputs in the report

    Scenario: Sync repairs generated files changed by hand
      Given I have already run `dry-ai sync` for command, rule, and skill outputs
      When I edit generated agent files directly
      And I run `dry-ai sync` again
      Then dry-ai restores generated files from source
      And keeps sync-manifest.json aligned with managed outputs
      And lists repaired outputs in the report

    Scenario: Reinstall managed outputs removed from disk while sources stay the same
      Given I have already run `dry-ai sync` for command, rule, and skill outputs
      When I delete a managed Copilot command output file while leaving config sources unchanged
      And I run `dry-ai sync` again
      Then dry-ai restores that output from the unchanged source
      And keeps sync-manifest.json aligned with managed outputs

    Scenario: Discover only markdown files directly under commands and rules
      Given I have top-level and nested markdown under commands and rules plus one valid skill
      When I run `dry-ai sync`
      Then dry-ai ignores nested command and rule markdown discovered only via depth
      And records only top-level commands and rules in sync-manifest.json

    Scenario: Sync skips invalid frontmatter without blocking valid sources
      Given I have added valid sources and sources with invalid frontmatter to the config root
      When I run `dry-ai sync`
      Then dry-ai writes the valid outputs
      And skips invalid outputs with warnings
      And records only written outputs in sync-manifest.json

    Scenario: Sync with custom roots writes to the requested locations
      Given I have added one command, one rule, and one skill to the config root
      When I run `dry-ai sync` with custom config and output roots
      Then dry-ai writes agent outputs under the requested output root
      And writes sync-manifest.json beside the requested config root
      And shows the resolved output root in the report

  Rule: Valid frontmatter controls rendered outputs

    Scenario: Omit unresolved optional frontmatter keys
      Given I have command and rule sources with unresolved optional frontmatter
      When I run `dry-ai sync`
      Then dry-ai omits optional frontmatter keys with nothing to render from the written file

    Scenario: Keep body whitespace normalization consistent across output types
      Given I have command and rule sources with padded body whitespace
      When I run `dry-ai sync`
      Then dry-ai trims leading and trailing body whitespace the same way for commands, rules, and skills before writing

    Scenario: Write command and rule outputs with only top-level metadata when agents is omitted
      Given I have command and rule sources without an `agents` map
      When I run `dry-ai sync`
      Then dry-ai renders commands and rules from shared top-level frontmatter

  Rule: Skill targets mirror source trees

    Scenario: Mirror the complete skill source tree into each agent target
      Given I have a skill source tree with nested files
      When I run `dry-ai sync`
      Then dry-ai copies nested folders and extra files inside each skill into both agent skill targets

    Scenario: Remove deleted source files from copied skill targets on the next sync
      Given I have synced a skill source tree with a file that is later deleted
      When I run `dry-ai sync`
      Then dry-ai removes vanished source skill files from both mirrored skill trees on the next sync

  Rule: Sync manifest tracks managed artifact state

    Scenario: Write mixed config manifest rows without dropping or merging kinds
      Given I have mixed command, rule, and skill sources
      When I run `dry-ai sync`
      Then dry-ai lists commands, rules, and skills as distinct sync-manifest.json rows without dropping kinds

    Scenario: Recover when sync-manifest.json is not valid JSON
      Given I have the basic trio under the config root and sync-manifest.json contains invalid JSON
      When I run `dry-ai sync`
      Then dry-ai warns that sync-manifest.json is damaged or incomplete
      And replaces sync-manifest.json with rows for the current trio outputs

    Scenario: Recover when sync-manifest.json cannot be read
      Given I have the basic trio and sync-manifest.json is unreadable by the filesystem mock
      When I run `dry-ai sync`
      Then dry-ai warns that sync-manifest.json could not be read
      And replaces sync-manifest.json with rows for the current trio outputs

    Scenario: Rebuild sync-manifest.json when the on-disk manifest version is older than the tool expects
      Given I have the basic trio and sync-manifest.json declares an outdated manifest schema version
      When I run `dry-ai sync`
      Then dry-ai warns that sync-manifest.json did not match the expected layout
      And writes sync-manifest.json using the current schema version and trio outputs

  Rule: Aligned sync state is a no-op

    Scenario: Report no applied changes when sync state stays aligned
      Given I have already synced the basic trio once so outputs match sources
      When I run `dry-ai sync`
      Then dry-ai reports that nothing needs applying on a second sync against an already-aligned tree

  Rule: Ownership conflicts skip only conflicting artifacts

    Scenario: Write manifest rows and report text only for non-conflicting outputs
      Given I have a command and skill that share the same Cursor-facing name
      When I run `dry-ai sync`
      Then dry-ai mentions only written paths in the manifest and report, not paths skipped for conflicts

    Scenario: Sync rule and skill sources that share the same basename without ownership conflicts
      Given I have a rule and a skill whose rule stem and skill folder share the same basename
      When I run `dry-ai sync`
      Then dry-ai writes both rule and skill outputs for every supported agent
      And reports no skipped ownership conflicts

    Scenario: Sync rule and command sources that share the same logical name without ownership conflicts
      Given I have a rule stem and command name that match and no skill reuses that Cursor skill directory
      When I run `dry-ai sync`
      Then dry-ai writes both rule and command outputs for every supported agent
      And reports no skipped ownership conflicts

  Rule: Invalid frontmatter controls skipped outputs

    Scenario: Write valid command output when another agent block is invalid
      Given I reset the workspace before syncing commands with one valid and one invalid agent block each
      When I run `dry-ai sync`
      Then dry-ai still writes the healthy agent command and skips the invalid block with a useful warning

    Scenario: Skip a command when top-level frontmatter fails validation
      Given I have a command whose top-level frontmatter is missing a required description
      When I run `dry-ai sync`
      Then dry-ai skips the broken command without leaving partial Copilot or Cursor files

    Scenario: Skip a rule when top-level frontmatter fails validation
      Given I have one invalid rule and one valid command in the config root
      When I run `dry-ai sync`
      Then dry-ai skips the broken rule without leaving partial Copilot or Cursor rule files
      And still writes the valid command outputs

    Scenario: Keep syncing after one command or rule is skipped for invalid frontmatter
      Given I have one invalid command and one valid command in the config root
      When I run `dry-ai sync`
      Then dry-ai still syncs later valid sources cleanly after it skips an earlier command or rule

    Scenario: Skip a command agent output when its per-agent block fails validation
      Given I have a command with a valid Copilot block and an invalid Cursor block
      When I run `dry-ai sync`
      Then dry-ai skips only the failing per-agent slice while other agents continue to receive output

    Scenario: Warn and skip without partial outputs when frontmatter parses but validation fails
      Given I have a command whose top-level frontmatter is missing a required description
      When I run `dry-ai sync`
      Then dry-ai warns, skips the invalid file, and avoids half-written outputs

  Rule: CLI roots determine source, output, and manifest locations

    Scenario: Read sources from an absolute config root while using the default output tree
      Given I have a command under an absolute config root outside the default path
      When I run `dry-ai sync`
      Then dry-ai still writes into the default home-relative layout when I pass an absolute `--config-root` without overriding outputs

    Scenario: Prefer --output-root when --test is also passed
      Given I have the usual command, rule, and skill under the default config root
      When I run `dry-ai sync` with --test and an explicit output root
      Then dry-ai prefers an explicit `--output-root` over the preview path implied by `--test`

    Scenario: Write outputs under the test preview tree when only --test is passed
      Given I have the usual command, rule, and skill under the default config root
      When I run `dry-ai sync` with only --test
      Then dry-ai writes agent outputs under the resolved test preview directory
      And logs the resolved output root after a successful sync

    Scenario: Keep --config-root from changing the output root
      Given I have a command only under an alternate absolute config root
      When I run `dry-ai sync`
      Then dry-ai does not silently redirect agent outputs when I pass only `--config-root`

    Scenario: Reject an unsupported CLI flag
      Given I pass only invalid CLI options before sync
      When I run `dry-ai sync`
      Then dry-ai stops the run with a clear error for an unknown flag

    Scenario: Reject a missing config root path
      Given I point --config-root at a path that does not exist
      When I run `dry-ai sync`
      Then dry-ai fails fast with a clear error for a missing configuration directory

  Rule: Registry and manifest metadata are validated before sync work proceeds

    Scenario: Fail when the manifest names an agent that no longer exists
      Given sync-manifest.json references a retired agent and a matching output file on disk
      When I run `dry-ai sync`
      Then dry-ai exits before doing work when the manifest names an unregistered agent

  Rule: Filesystem failures fail the run without silent partial success

    Scenario: Surface read errors for discovered files
      Given I have a command file that the mock filesystem refuses to read
      When I run `dry-ai sync`
      Then dry-ai surfaces unreadable discovered sources as failures instead of skipping them quietly

    Scenario: Surface filesystem errors from writing a target file
      Given I have a command source and a Copilot output path rigged to fail writes
      When I run `dry-ai sync`
      Then dry-ai surfaces failed writes to a target file as hard errors

    Scenario: Surface filesystem failures when applying a directory skill target
      Given I run subcases that each reset the mock, seed a skill, and break Copilot skill mirroring
      When I run `dry-ai sync`
      Then dry-ai aborts the run when copying a directory skill target fails

    Scenario: Surface ensureDir failures before a write or copy
      Given I have a command source and a Cursor skill parent directory rigged to fail mkdir
      When I run `dry-ai sync`
      Then dry-ai stops the workflow on directory creation failures before writes or copies proceed

  Rule: Empty configs write empty sync state without touching untracked outputs

    Scenario: Sync an empty config without touching untracked outputs
      Given the config tree is empty but an unmanaged Copilot prompt already exists under home
      When I run `dry-ai sync`
      Then dry-ai writes empty sync state without creating agent outputs or touching untracked files

  Rule: Sync reports describe applied, removed, skipped, and unchanged work consistently

    Scenario: Render a coherent report for mixed applied and skipped work
      Given I have a command and skill that share a name so installs and skips appear together
      When I run `dry-ai sync`
      Then dry-ai renders applied work and skipped conflicts coherently in the same report
