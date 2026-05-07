Feature: dry-ai sync
  # As a dry-ai user
  # I want to run `dry-ai sync` against commands, rules, and skills
  # So that Copilot and Cursor outputs under the output root reflect the configuration sources

  # Background:
  #   Given the dry-ai sync Vitest suite with an in-memory Effect FileSystem mock, glob, and os.homedir
  #   And stdout and stderr are captured for assertions
  #   And a virtual configuration root with commands/, rules/, and skills/ directories
  #   And a virtual home directory is used as the default agent output root

  Rule: Valid sources produce expected agent artifacts

    Scenario Outline: Sync basic sources for each supported agent
      Given the config root contains one command, one rule, and one skill
      When I run "dry-ai sync"
      Then <agent> command output is written
      And <agent> rule output is written
      And <agent> skill output is written

      Examples:
            | agent |
            | copilot |
            | cursor |

    Scenario Outline: Sync two files per kind for each supported agent
      Given the config root contains two commands, two rules, and two skills
      When I run "dry-ai sync"
      Then <agent> has generated outputs for every source

      Examples:
        | agent   |
        | copilot |
        | cursor  |

    Scenario Outline: Sync two source kinds without the third kind
      Given the config root contains sources for <includedKinds> and no sources for the other kind
      When I run "dry-ai sync"
      Then <agent> has generated outputs for <includedKinds>
      And <agent> has no generated outputs for the other kind

      Examples:
        | agent   | includedKinds |
        | copilot | command, rule   |
        | copilot | command, skill  |
        | copilot | rule, skill     |
        | cursor  | command, rule   |
        | cursor  | command, skill  |
        | cursor  | rule, skill     |

    Scenario Outline: Sync one source kind
      Given the config root contains only <kind> sources
      When I run "dry-ai sync"
      Then <agent> has generated outputs for <kind>
      And <agent> has no generated outputs for the other source kinds

      Examples:
        | agent   | kind    |
        | copilot | command |
        | copilot | rule    |
        | copilot | skill   |
        | cursor  | command |
        | cursor  | rule    |
        | cursor  | skill   |

    Scenario: Write the basic trio to every supported agent target
      Given the config root contains one command, one rule, and one skill
      When I run "dry-ai sync"
      Then every supported agent target contains its generated outputs

    Scenario: Write one output per rule file
      Given the config root contains two rule files
      When I run "dry-ai sync"
      Then each rule file has a Copilot rule output
      And each rule file has a Cursor rule output
