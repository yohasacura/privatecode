---
name: grill-me
description: Interview the user relentlessly about a plan, design or feature until every decision is settled — one question at a time, each with a recommended answer, reading the codebase first whenever the code can answer. Use when asked to grill, interrogate, stress-test or pressure-test a plan, or before starting a large change.
argument-hint: [the plan, or a file that holds it]
---

# Grill me

The person has a plan and wants it interrogated until nothing is left to guess. You walk
the design tree branch by branch, resolve decisions one at a time, and stop only when
every open question has an answer. The output is a settled plan, not a conversation.

## Rules

- **One question at a time.** Never batch. Each question is asked with `AskUserQuestion`
  and waits for its answer before the next.
- **Recommend before you ask.** Every question carries your recommended answer as the
  FIRST option, marked "(recommended)", with one line of why. The person should be able to
  accept it with a click.
- **The codebase answers before the person does.** If a question can be settled by reading
  the code — what a function returns, which files import a module, whether a table exists
  — use `Grep` and `Read` and settle it yourself. Ask people only what the code cannot say:
  intent, priorities, constraints, what they would rather give up.
- **Concrete over abstract.** "Should the cache be per session or per workspace?" beats
  "How should caching work?". Offer two to four options; use free text only when the
  options are unknowable.
- **Follow dependencies.** A decision that changes other decisions is asked first. When an
  answer reopens something already settled, say so and re-ask.
- **Do not build anything.** This skill produces decisions. Building comes after, and only
  if asked.

## Procedure

1. Read the plan: the message, the file named in `$ARGUMENTS`, or the plan file in the
   workspace (`Grep` for "plan" in `docs/` and `.privatecode/` if none is named).
2. Build the decision tree before asking anything. Branches to cover, in this order:
   - **Goal** — what must be true when it is done; what is explicitly out of scope.
   - **Users and triggers** — who or what starts it, how often, from where.
   - **Data** — what is stored, where, in what shape, what must never be lost.
   - **Interfaces** — commands, APIs, files, UI; their exact names and shapes.
   - **Constraints** — performance, memory, offline, platform, licensing, security.
   - **Failure modes** — what happens when each step fails; what the person sees.
   - **Migration and rollout** — existing data, existing users, feature flags, undo.
   - **Verification** — what proves it works; which tests; what is measured.
   For each branch, list the decisions the plan leaves open.
3. For each open decision, in dependency order: settle it from the code if you can (say
   what you found and where); otherwise ask, one question, recommendation first. Record
   the answer.
4. When no open decisions remain, write the summary:
   - a table of every decision with its answer and who decided (code, you, the person);
   - the risks that remain and what would retire each;
   - the first three steps of the build, if the person wants one.
5. Stop. Ask whether to proceed to building only if the person has not said.

## Signs you are doing it wrong

- Three questions in one message.
- A question the code could have answered ("does the project use TypeScript?").
- An option list without a recommendation.
- Writing code before the summary.
