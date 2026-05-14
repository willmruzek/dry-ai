import { Command } from 'commander';
import dedent from 'dedent';
import { z } from 'zod';

import type { CommandEnv } from '../../lib/command-env.js';
import {
  nonEmptyOptionStringSchema,
  parseOptionsObject,
  parseOptionValue,
} from '../../lib/command-options.js';

import { runSkillsAddCommand } from './add.js';
import { runSkillsListCommand } from './list.js';
import { runSkillsRemoveCommand } from './remove.js';
import { runSkillsUpdateAllCommand } from './update-all.js';
import { runSkillsUpdateCommand } from './update.js';

const skillsImportOptionsSchema = z.object({
  skill: z.array(z.string()).optional(),
  as: nonEmptyOptionStringSchema.optional(),
  pin: z.boolean().optional().default(false),
  path: nonEmptyOptionStringSchema.optional(),
  ref: nonEmptyOptionStringSchema.optional(),
});
type SkillsImportOptions = z.output<typeof skillsImportOptionsSchema>;

const skillsUpdateOptionsSchema = z.object({
  force: z.boolean().optional().default(false),
});

type SkillsUpdateOptions = z.output<typeof skillsUpdateOptionsSchema>;

/**
 * Registers the managed skills command tree on the parent CLI program.
 */
export function addSkillsCommand(input: {
  program: Command;
  commandName: string;
  resolveEnv: () => CommandEnv;
}): Command {
  const { program, commandName, resolveEnv } = input;

  const skills = program
    .command('skills')
    .description('Manage imported skills')
    .usage('<subcommand> [args]')
    .helpOption('-h, --help', 'Display this message')
    .helpCommand(false)
    .addHelpText(
      'after',
      '\n' +
        dedent`
        Examples:
          ${commandName} skills list
          ${commandName} skills add anthropics/skills --skill skill-creator
          ${commandName} skills add anthropics/skills --path . --skill review-helper
          ${commandName} skills add anthropics/skills --path tools --skill review-helper
          ${commandName} skills add vercel-labs/agent-skills --skill pr-review commit
          ${commandName} skills add vercel-labs/agent-skills --skill pr-review --skill commit
          ${commandName} skills update skill-creator
      `,
    )
    .action(() => {
      skills.outputHelp();
    });

  skills
    .command('list')
    .description('List local skills')
    .action(async () => {
      await runSkillsListCommand(resolveEnv());
    });

  skills
    .command('add <repo>')
    .description('Add managed skills from a remote repository')
    .option(
      '--skill <names...>',
      'Skill directory names: pass several after one --skill, or repeat --skill (duplicates ignored)',
    )
    .option(
      '--path <repoPath>',
      'Resolve each --skill from a different repository subdirectory; use . for the repository root instead of the default skills/ directory',
      parseOptionValue({
        schema: nonEmptyOptionStringSchema,
        optionLabel: '--path',
      }),
    )
    .option(
      '--as <name>',
      'Store the imported skill under a different local managed name',
      parseOptionValue({
        schema: nonEmptyOptionStringSchema,
        optionLabel: '--as',
      }),
    )
    .option(
      '--pin',
      'Pin the import to the currently resolved commit instead of tracking a moving ref',
    )
    .option(
      '--ref <gitRef>',
      'Fetch a specific git ref instead of the remote default',
      parseOptionValue({
        schema: nonEmptyOptionStringSchema,
        optionLabel: '--ref',
      }),
    )
    .action(async (repo: string, options) => {
      const parsedOptions: SkillsImportOptions = parseOptionsObject({
        schema: skillsImportOptionsSchema,
        options,
        optionsLabel: 'skills add options',
      });

      await runSkillsAddCommand(resolveEnv(), {
        repo,
        repoPath: parsedOptions.path,
        skillNames: parsedOptions.skill ?? [],
        asName: parsedOptions.as,
        pin: parsedOptions.pin,
        ref: parsedOptions.ref,
      });
    });

  skills
    .command('remove <name>')
    .description('Remove a managed skill')
    .action(async (skillName: string) => {
      await runSkillsRemoveCommand(resolveEnv(), { skillName });
    });

  skills
    .command('update <name>')
    .description('Update a managed skill from its tracked source')
    .option(
      '--force',
      'Overwrite local skill edits with the fetched remote copy',
    )
    .action(async (skillName: string, options) => {
      const parsedOptions: SkillsUpdateOptions = parseOptionsObject({
        schema: skillsUpdateOptionsSchema,
        options,
        optionsLabel: 'skills update options',
      });

      await runSkillsUpdateCommand(resolveEnv(), {
        force: parsedOptions.force,
        skillName,
      });
    });

  skills
    .command('update-all')
    .description('Update all managed skills from their tracked sources')
    .option(
      '--force',
      'Overwrite local skill edits with the fetched remote copy',
    )
    .action(async (options) => {
      const parsedOptions: SkillsUpdateOptions = parseOptionsObject({
        schema: skillsUpdateOptionsSchema,
        options,
        optionsLabel: 'skills update-all options',
      });

      await runSkillsUpdateAllCommand(resolveEnv(), {
        force: parsedOptions.force,
      });
    });

  return skills;
}
