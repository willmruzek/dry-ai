import { Command } from 'commander';
import dedent from 'dedent';
import { z } from 'zod';
import {
  nonEmptyOptionStringSchema,
  parseOptionsObject,
  parseOptionValue,
} from '../../lib/command-options.js';
import { type AgentsContext } from '../../lib/context.js';
import { runSkillsImportCommand } from './import.js';
import { runSkillsListCommand } from './list.js';
import { runSkillsRemoveCommand } from './remove.js';
import { runSkillsUpdateAllCommand } from './update-all.js';
import { runSkillsUpdateCommand } from './update.js';

const skillsImportOptionsSchema = z.object({
  as: nonEmptyOptionStringSchema.optional(),
  pin: z.boolean().optional().default(false),
  ref: nonEmptyOptionStringSchema.optional(),
});
type SkillsImportOptions = z.output<typeof skillsImportOptionsSchema>;

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
          ${commandName} import anthropics/skills skills/skill-creator
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
    .command('import <repo> [skillPath]')
    .description('Import a managed skill')
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
    .action(async (repo: string, skillPath: string | undefined, options) => {
      const parsedOptions: SkillsImportOptions = parseOptionsObject({
        schema: skillsImportOptionsSchema,
        options,
        optionsLabel: 'skills import options',
      });

      await runSkillsImportCommand(resolveContext(), {
        repo,
        skillPath,
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
    .command('update <name>')
    .description('Update a managed skill from its tracked source')
    .action(async (skillName: string) => {
      await runSkillsUpdateCommand(resolveContext(), { skillName });
    });

  skills
    .command('update-all')
    .description('Update all managed skills from their tracked sources')
    .action(async () => {
      await runSkillsUpdateAllCommand(resolveContext());
    });

  return skills;
}
