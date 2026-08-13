import { readSkillText } from '../skills/skills.js'
import type { Tool } from './types.js'

export interface UseSkillArgs {
  name: string
  file?: string
}

/**
 * The other half of `skills/skills.ts`: the catalogue names a procedure, this reads it.
 *
 * `readOnly: true`, and meant literally — this opens a file the user wrote and returns its
 * text. It runs nothing, and the instructions it returns get no authority from having
 * arrived through a tool: whatever the body asks for next goes through the permission engine
 * exactly as if the model had thought of it unaided. That is why it is safe for this to be
 * available in plan mode, where reading a procedure is often the entire point.
 *
 * There is deliberately no permission key beyond the tool name. A skill is content the user
 * placed in their own skills folder; gating the READING of it would be gating them from
 * their own notes, and the actions it leads to are gated already.
 */
export const useSkillTool: Tool<UseSkillArgs> = {
  name: 'use_skill',
  readOnly: true,
  description:
    'Read one of the skills listed in your system prompt: the full procedure behind the ' +
    'name. Call this BEFORE starting a task a skill covers — the catalogue line is a label, ' +
    'not the steps. Pass `file` to read one of the files that skill ships beside it.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The skill name, exactly as listed in the prompt.' },
      file: {
        type: 'string',
        description:
          'Optional: a file bundled with the skill, relative to its folder. Omit to read ' +
          'the skill itself.',
      },
    },
    required: ['name'],
  },
  validate(raw) {
    const r = raw as Partial<UseSkillArgs>
    if (typeof r?.name !== 'string' || r.name.trim() === '') {
      return { ok: false, error: 'name must be the name of a skill listed in your prompt' }
    }
    if (r.file !== undefined && typeof r.file !== 'string') {
      return { ok: false, error: 'file must be a path relative to the skill folder' }
    }
    const args: UseSkillArgs = { name: r.name.trim() }
    if (typeof r.file === 'string' && r.file.trim() !== '') args.file = r.file.trim()
    return { ok: true, args }
  },
  permissionKey(args) {
    return { tool: 'use_skill', target: args.name }
  },
  async execute(args, ctx) {
    const loaded = ctx.skills
    // Not an error the model caused, and worth distinguishing: a session built without
    // skills is a different situation from a name that does not exist.
    if (loaded === undefined || loaded.skills.length === 0) {
      return { ok: false, content: 'This session has no skills loaded.' }
    }
    const skill = loaded.skills.find((s) => s.name === args.name)
    if (skill === undefined) {
      return {
        ok: false,
        content: `There is no skill called "${args.name}". Available: ` +
          `${loaded.skills.map((s) => s.name).join(', ')}.`,
      }
    }

    let text: string
    try {
      text = readSkillText(skill, args.file)
    } catch (e) {
      return { ok: false, content: (e as Error).message }
    }

    // The header states what was opened and what else is in the folder, so a skill that
    // depends on a reference table does not need the model to guess that one exists.
    const extras = args.file === undefined && skill.files.length > 0
      ? `\nFiles bundled with this skill (read with use_skill(name, file)): ${skill.files.join(', ')}`
      : ''
    const header = args.file === undefined
      ? `Skill "${skill.name}" (${skill.scope} scope)${extras}`
      : `${args.file}, from the skill "${skill.name}"`
    return { ok: true, content: `${header}\n\n${text}` }
  },
}
