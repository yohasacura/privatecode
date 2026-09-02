---
name: skill-creator
description: Create a new skill for PrivateCode or improve an existing one — a SKILL.md folder the model reads when its task comes up. Use when asked to create, write, add, fix or review a skill, or to turn a repeated procedure into one.
argument-hint: [what the skill should cover]
---

# Writing a skill

A skill is a procedure the model chooses to read when the task it describes comes up. Its
one-line description sits in the system prompt permanently; its body is read only when
needed. That is why the description is the part that matters most: it is the only thing
the model sees before deciding to open the skill.

## Where a skill lives

| folder | applies to |
|---|---|
| `.privatecode/skills/<name>/SKILL.md` | this workspace |
| `%APPDATA%\PrivateCode\skills\<name>\SKILL.md` | every workspace on this machine |
| a plugin's `skills/<name>/SKILL.md` | wherever the plugin is enabled (installed with `/plugin install`) |

The folder name IS the skill's name: lowercase letters, digits and dashes, starting with a
letter or digit (`release-checklist`, `pptx`). A project skill replaces a user skill of
the same name; both replace a bundled one.

A skill is also a slash command: `/name arguments` sends its body to the model with
`$ARGUMENTS` replaced.

## The file

```markdown
---
name: release-checklist
description: Cut a release of this project — bump the version, build, tag, write the notes. Use when asked to release, ship, tag a version or prepare release notes.
argument-hint: [version]
---

# Cutting a release

1. Read `CHANGELOG.md` and the commits since the last tag (`git log <tag>..HEAD --oneline`).
2. …
```

Frontmatter fields:

- `name` — must equal the folder name.
- `description` — required, at most 400 characters. Say WHAT the skill does and WHEN to use
  it, in the third person, with the words a person would actually say ("release", "ship",
  "tag a version"). A description that only names the topic ("Release process") never
  fires; one that lists the triggers does.
- `argument-hint` — optional; shown in the command picker (`[version]`).
- `user-invocable: false` — optional; the skill is for the model only, not a slash command.
- `disable-model-invocation: true` — optional; the opposite: a slash command for the
  person, never listed to the model.

The body:

- Imperative, numbered steps. Name the tools to use (`Read`, `Grep`, `Edit`, `Bash`) and
  the files to open. Say what "done" looks like and how to check it.
- Keep it under about 20 KB; the whole body lands in the conversation when read.
- Reference material (a table of codes, a template, a script) goes in files beside
  `SKILL.md`. The model reads them with `Skill(name, file)`; the skill's folder path is
  in that tool's reply, so a script can be run from where it is.
- No secrets, no credentials: the file is plain text in a folder.

## The procedure

1. **Find out what recurs.** If the request does not say, ask ONE question with
   `AskUserQuestion`: which task keeps coming up, and what goes wrong when it is done
   without a procedure. The answer to the second half is the skill's value.
2. **Read how it is done today.** `Grep` and `Read` the scripts, docs and commands the
   task already uses; a skill that contradicts the repository is worse than none.
3. **Draft the description first.** Write the trigger words down, then the one-sentence
   purpose. Check it against the rule above: what and when, third person, under 400 chars.
4. **Write the body** as steps a careful colleague could follow without you. Put anything
   longer than a screen into a file beside it.
5. **Write the files** with `Write` into the right folder (ask which scope if unclear; the
   project folder is the default for project-specific procedures).
6. **Check it loaded.** Settings → Skills lists every skill and every folder that failed
   to load, with the reason. A new skill is listed to the model from the next session.
7. **Try it once.** Invoke it as `/name` on a real case and fix what the steps got wrong.

## Common mistakes

- A description that is a title ("Docker") instead of a trigger ("Use when asked to build,
  run or debug the Docker image, or when a Dockerfile is edited").
- `name` in the frontmatter that does not match the folder — the folder wins, and the
  mismatch is reported in Settings → Skills.
- No `---` frontmatter block at all: the skill is skipped, because there is no description
  to show the model.
- A body that pastes a whole document. Put the document beside the skill and tell the
  model which part to read.
- Steps that assume the model remembers the last time. It does not; each use starts fresh.
