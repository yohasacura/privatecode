import type { Tool } from './types.js'

export interface AskUserArgs {
  question: string
  options: string[]
}

export const askUserTool: Tool<AskUserArgs> = {
  name: 'ask_user',
  readOnly: true,
  description:
    'Ask the user a question with suggested options. The host always accepts free text in addition ' +
    'to the suggested options.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask. Max 500 characters.' },
      options: {
        type: 'array',
        items: { type: 'string', description: 'A suggested option. Max 100 characters.' },
        description: '2–4 distinct options.',
      },
    },
    required: ['question', 'options'],
  },
  validate(raw) {
    const r = raw as Partial<AskUserArgs>
    if (typeof r?.question !== 'string' || r.question.trim() === '') {
      return { ok: false, error: 'question must be a non-empty string' }
    }
    if (r.question.length > 500) {
      return { ok: false, error: 'question must be at most 500 characters' }
    }
    if (!Array.isArray(r?.options)) {
      return { ok: false, error: 'options must be an array' }
    }
    if (r.options.length < 2) {
      return { ok: false, error: 'options must have at least 2 items' }
    }
    if (r.options.length > 4) {
      return { ok: false, error: 'options must have at most 4 items' }
    }

    const seen = new Set<string>()
    for (let i = 0; i < r.options.length; i++) {
      const opt = r.options[i]
      if (typeof opt !== 'string' || opt.trim() === '') {
        return { ok: false, error: `options[${i}] must be a non-empty string` }
      }
      if (opt.length > 100) {
        return { ok: false, error: `options[${i}] must be at most 100 characters` }
      }
      if (seen.has(opt)) {
        return { ok: false, error: `options must be distinct; options[${i}] is a duplicate` }
      }
      seen.add(opt)
    }

    return { ok: true, args: { question: r.question, options: r.options } }
  },
  async execute(args, ctx) {
    if (!ctx.interaction) {
      return {
        ok: false,
        content: 'ask_user is not available in this session (no interactive host); decide yourself and state the assumption.',
      }
    }

    const answer = await ctx.interaction.askUser({ question: args.question, options: args.options })
    return { ok: true, content: `The user answered: ${answer}` }
  },
}
