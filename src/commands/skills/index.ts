import { Command } from 'commander';
import dedent from 'dedent';
import { z } from 'zod';
import {
  nonEmptyOptionStringSchema,
  parseOptionsObject,
  parseOptionValue,
} from '../../lib/command-options.js';
import { type AgentsContext } from '../../lib/context.js';
import { runSkillsAddCommand } from './add.js';
import { runSkillsListCommand } from './list.js';
import { runSkillsRehashAllCommand } from './rehash-all.js';
import { runSkillsRehashCommand } from './rehash.js';
import { runSkillsRemoveCommand } from './remove.js';
import { runSkillsUpdateAllCommand } from './update-all.js';
import { runSkillsUpdateCommand } from './update.js';

const skillsImportOptionsSchema = z.object({
  skill: z.array(z.string()).optional(),
  as: nonEmptyOptionStringSchema.optional(),
  pin: z.boolean().optional().default(false),
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
  parent: Command;
  commandName: string;
  resolveContext: () => AgentsContext;
}): Command {
  const { parent, commandName, resolveContext } = input;
  const skills = parent
    .command('skills')
    .description('Manage imported skills')
    .usage('<subcommand> [args]')
    .helpOption('-h, --help', 'Display this message')
    .helpCommand(false)
    .addHelpText(
      'after',
      dedent`
        Examples:
          ${commandName} list
          ${commandName} add anthropics/skills --skill skill-creator
          ${commandName} add vercel-labs/agent-skills --skill pr-review commit
          ${commandName} rehash skill-creator
          ${commandName} update skill-creator
      `,
    )
    .action(() => {
      skills.outputHelp();
    });

  skills
    .command('list')
    .description('List local skills')
    .action(async () => {
      await runSkillsListCommand(resolveContext());
    });

  skills
    .command('add <repo>')
    .description('Add managed skills from a remote repository')
    .option(
      '--skill <names...>',
      'Import one or more skills from the repository root skills/ directory',
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

      await runSkillsAddCommand(resolveContext(), {
        repo,
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
      await runSkillsRemoveCommand(resolveContext(), { skillName });
    });

  skills
    .command('rehash <name>')
    .description('Refresh stored file hashes for one managed skill')
    .action(async (skillName: string) => {
      await runSkillsRehashCommand(resolveContext(), { skillName });
    });

  skills
    .command('rehash-all')
    .description('Refresh stored file hashes for all managed skills')
    .action(async () => {
      await runSkillsRehashAllCommand(resolveContext());
    });

  skills
    .command('update <name>')
    .description('Update a managed skill from its tracked source')
    .option('--force', 'Overwrite local skill edits with the fetched remote copy')
    .action(async (skillName: string, options) => {
      const parsedOptions: SkillsUpdateOptions = parseOptionsObject({
        schema: skillsUpdateOptionsSchema,
        options,
        optionsLabel: 'skills update options',
      });

      await runSkillsUpdateCommand(resolveContext(), {
        force: parsedOptions.force,
        skillName,
      });
    });

  skills
    .command('update-all')
    .description('Update all managed skills from their tracked sources')
    .option('--force', 'Overwrite local skill edits with the fetched remote copy')
    .action(async (options) => {
      const parsedOptions: SkillsUpdateOptions = parseOptionsObject({
        schema: skillsUpdateOptionsSchema,
        options,
        optionsLabel: 'skills update-all options',
      });

      await runSkillsUpdateAllCommand(resolveContext(), {
        force: parsedOptions.force,
      });
    });

  return skills;
}
