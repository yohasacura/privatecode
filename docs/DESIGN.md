# PrivateCode — Design Decisions

**Status:** design agreed 2026-08-02. No code written yet.
**Goal:** a fully offline coding agent with Claude Code's feature set, purpose-built for
one model — Qwen3.6-35B-A3B-UD-Q4_K_XL served by llama.cpp — instead of being
model-agnostic like Cline / KiloCode.

---

## 1. Why this exists

Cline and KiloCode feel unreliable because they are model-agnostic: they push a
hand-rolled XML tool protocol that no model was trained on, re-send context the
server already has cached, and slide their context window in ways that are cheap on a
cloud API and ruinous on a local recurrent-attention model.

PrivateCode targets exactly one model on exactly one server, so every layer can exploit
facts about that model that a general-purpose tool cannot assume.

---

## 2. The measured numbers everything is derived from

Source: `Start-QwenServer.ps1`, `server.log`, and the GGUF analysis recorded in the
AnyRunner notes. Re-measure only if the model or server config changes.

> **Re-measured 2026-08-02 by `spike/grammar_spike.py` against the live server**
> (build b10202, `-ncmoe 22 -t 6`, MTP n-max 3). Generation and prefill are both about
> twice as fast as the figures previously on record — those came from `llama-bench`,
> which understates this configuration, the same way it understated prompt processing
> before. VRAM free measured at **1364 MB**, above the 1 GB rule, so `-ncmoe 22` is
> confirmed good and the "VERIFY on first start" note in `Start-QwenServer.ps1` is closed.

| quantity | value | consequence |
|---|---|---|
| generation | **60.6 tok/s** measured (was 30.5 on record) | one output token = 16 ms. Still the scarce resource, but half as scarce |
| MTP draft acceptance | 0.73–0.76 measured | the speculation is what buys the 2× |
| prompt processing | **545 tok/s** measured (was 363–438 on record) | one input token = 1.8 ms — **33× cheaper than output** |
| context | 131072 | ~90–100K usable before compaction |
| KV cache | 20 KiB/token (only 10 of 41 blocks carry KV) | 131K ctx = 2.5 GiB |
| architecture | 30 of 41 blocks are Gated DeltaNet (recurrent) | per-token cost is **independent of history length** |
| `--cache-reuse` | **impossible** — disabled by llama.cpp at load | only longest-common-prefix reuse works |
| MTP speculative decoding | acceptance 0.71–0.83, mean 2.4–2.7 tok/pass | requires `-np 1`; a second slot means giving it up |
| VRAM exchange rate | 464 MiB = 1 expert layer = 23.8k ctx = ~8 % of gen speed | the currency for every server-side tradeoff |
| VRAM headroom rule | **≥ 1 GB free, hard requirement** | near-edge configs collapse 37.5 → 23 tok/s |

### The three laws these imply

1. **The prompt is append-only.** Deleting or rewriting anything in the middle of the
   history forces a re-prefill of everything after it. Dropping the oldest tool result
   from a 100K context costs ~4 minutes of silence. Classic sliding-window context
   management is the single worst choice on this architecture.
2. **Output tokens are 13× more expensive than input tokens.** Diff-style edits beat
   whole-file rewrites; anything the model prints needlessly is seconds on the clock.
3. **Long context is nearly free at generation time.** 30 of 41 blocks are recurrent, so
   a 100K conversation generates at almost the same speed as a 10K one. Appending
   2000 tokens to a warm 100K context costs ~5 s. This removes the main economic
   argument for sub-agents, which exist in cloud tools to avoid re-billing context.

---

## 3. Topology

```
  work laptop (16 GB RAM)                    GPU laptop (RTX 3080 Ti 16 GB, i9-12900H)
  ┌──────────────────────────┐               ┌──────────────────────────────────────┐
  │ PrivateCode.exe          │   LAN only    │ llama.cpp server :8080  (OpenAI /v1) │
  │  · agent loop            │ ────────────► │  -ncmoe 22 -t 6, MTP, KV f16, -np 1  │
  │  · tools run here        │               │  started manually, never autostarts   │
  │  · workspace lives here  │               └──────────────────────────────────────┘
  └──────────────────────────┘                             (also holds D:\Projects)
```

- The model laptop stays a **dumb inference endpoint**. Nothing else runs on it during a
  session: `-ncmoe 22 -t 6` pins six CPU threads to expert offload on every single
  token, so a build job there would steal directly from generation speed.
- Which machine holds the workspace **varies by project**, so PrivateCode must install
  and run on both. The agent always operates on a local workspace — never over a
  network share.
- Network cost is a non-issue: ~2–10 KB per agent step over LAN, versus 33 ms per token.

**Setup prerequisite:** the existing firewall rule covers port **11434 only**. Port 8080
needs its own inbound rule (elevated) before the work laptop can reach the server.

---

## 4. Decisions

| area | decision | rationale |
|---|---|---|
| **form factor** | ~~standalone desktop app~~ → **VS Code extension** (reversed 2026-08-03 after using the built app: every UI complaint was about re-implementing IDE furniture worse than the IDE does). The engine is unchanged; the IDE supplies tree, diffs, settings, dialogs. See `docs/superpowers/plans/2026-08-03-vscode-extension.md` | user requirement, then user reversal on evidence |
| **stack** | Tauri 2 — Rust shell (window, fs, process spawning) + **TypeScript agent core** | ~70 MB RAM vs Electron's ~400; WebView2 already ships with Win11; the agent logic stays in the language Qwen writes best, so the model can maintain its own tool |
| **dev / build** | both on the GPU laptop; only the built `.exe` is copied to the work laptop | keeps the weak machine free of toolchains. Build while the server is stopped — Rust saturates all cores |
| **toolchain to install** | Rust + Node (~2 GB, one-time, then fully offline) | not currently present; .NET, git, ripgrep, Python 3.14 already are |
| **tool-call wire format** | native Qwen `tool_calls` via `--jinja`, **constrained by GBNF grammar** | the format the model was trained on, plus a sampler-level guarantee. A syntactically broken call becomes inexpressible rather than merely unlikely. One malformed 2000-token call would otherwise waste 66 s |
| **grammar scope** | rebuilt per mode — only currently-permitted tools appear in it | in plan mode the write tools are physically absent from the grammar. Stronger than post-hoc rejection, and costs zero tokens. Also keeps the model choosing among 5–7 options instead of 15 |
| **edit format** | SEARCH/REPLACE blocks, payload **inside** the normal JSON arguments | ~90 output tokens for a 3-line change vs ~3000 for a full rewrite. **Revised after the spike:** the original plan put the payload outside the JSON to dodge escaping errors. Measured on a file deliberately loaded with regexes, `@""` strings and quotes, there were **zero escaping failures** — llama.cpp's schema grammar makes malformed escaping unreachable. The non-standard channel bought nothing and is dropped |
| **argument validation** | every tool validates arguments **semantically**, not just against the schema, and re-asks on failure | empty-but-valid strings occur: 2 of 5 runs on a trivial file emitted an empty `search_text`, which passes JSON-schema validation and would silently no-op |
| **sampling** | **temp 0.6 / top-p 0.95 / top-k 20 everywhere** — Qwen's own recommendation, never lowered for "structured" output. Discipline comes from the system prompt and from `tool_choice=required`, not from narrowing the distribution | **Reversed by the spike.** The original plan used temp 0.1 for tool emission on the theory that creativity hurts structure. Measured, low temperature is the *cause* of the dominant failure mode: at 0.1 the thinking length is bimodal — either ~1.2–1.7k tokens and success, or 3.2k+ and a truncated spiral, with nothing in between, in half the runs. At 0.6 the tail vanishes entirely (12 consecutive runs, 1192–1991 tokens, zero truncations). This is the classic repetition trap of near-greedy decoding that Qwen's model card warns about |
| **step shape** | one call per step with `tool_choice=required` on any step that must end in an action; a forced continuation only as a fallback when `finish_reason == "length"` | the planned two-call-per-turn split was built to carry different temperatures. With one temperature everywhere it has no job left: in 6 of 6 runs the first call already produced the tool call and the second never fired |
| **thinking** | always on; a fast-mode flag is reserved but not surfaced | user's call. Past *completed* turns drop their thinking (matches Qwen's template); thinking is preserved **within** the current turn across tool round-trips so the model doesn't forget its own goal |
| **context full** | auto-compaction, **pre-computed in the background at 80 % fill** | summarising runs on top of the already-warm cache: prefill ≈ 0, ~2500 generated tokens ≈ 80 s, then ~10 s for the new prefix. Generating it while the user reads or types hides the pause entirely |
| **code search** | ripgrep + tree-sitter symbol map. **No embeddings.** | zero index to go stale, no second model, no VRAM contention. A stale semantic index is what makes competing tools confidently wrong about the user's own code |
| **permissions** | full Claude Code-equivalent: `allow`/`ask`/`deny` with `deny` winning; pattern rules (`Bash(dotnet test:*)`, `Edit(src/**)`); three merged settings layers (user → project → local) | user requirement. A pending prompt costs **zero tokens** — the KV cache sits untouched while the user decides |
| **modes** | normal (ask by rules) · plan (no write tools in grammar) · auto-edit · autopilot (explicit, red banner) | |
| **hard denies** | `rm -rf`, `git push`, `git reset --hard`, reading `.env`/`*.pem`/`id_rsa`, any path outside the workspace root | **Known limitation:** the deny list matches file *names*. A hardlink (`mklink /H`, no admin needed) gives a denied file's bytes a second, undenied name, and this is not detected — accepted deliberately, since an `nlink`-based backstop would also break pnpm's hardlinked `node_modules` layout, and the vector needs a link-creation capability nothing in this tool set grants. The same mechanism defeats containment, not just the name denylist: `mklink /H <root>\innocent.txt <a file outside the root>` produces a path `resolve()` accepts as inside the workspace whose bytes come from outside it. Bounded to files on the same volume; directories cannot be hardlinked. |
| **network** | denied to PrivateCode itself, allowed to child processes (`dotnet restore`, `npm install`) | user's call |
| **long-running commands** | `run_command` and `background_task` treat a process exit as *evidence*, not as completion: anything long-running carries a readiness condition (a file appears, a port answers, a marker is logged) and is polled against it | learned the hard way while installing the toolchain — the VS Build Tools installer returned exit code 0 and printed "Successfully installed" within seconds while the real 3.3 GB install ran on asynchronously for three more minutes. An agent that trusts exit codes will confidently report success on a job that has not started |
| **checkpoints** | none — the user's own git is the safety net | user's call. Mitigation: before autopilot starts, check `git status` and offer a WIP commit or stash if the tree is dirty |
| **sub-agents** | **not in v1** | with `-np 1` a sub-agent evicts the main KV cache: up to 2 minutes of silence on return. `-np 2` avoids that but halves per-session context to 65K and costs MTP. Law 3 means the usual payoff isn't there anyway |
| **sessions** | one active conversation; others persisted and resumable | matches the single server slot |
| **language** | everything in English — UI, system prompt, model replies | best instruction-following, and Russian costs 1.5–2× more tokens per character |
| **UI** | three panels: file tree · chat · diffs. Per-file accept/reject-with-comment. Live status bar: tok/s, context fill, MTP acceptance | a rejection comment goes back to the model, which redoes only that block |
| **interrupt** | Esc stops the stream; partial output is kept in the transcript marked interrupted; the user's note is appended | the prefix still matches, so resuming costs seconds |
| **eval harness** | not built | user's call. Sessions are persisted in full, so success rate, retry count and tok/s can be extracted from the logs later without building anything |

---

## 5. Tools exposed to the model

14 tools, plus a reserved slot for web and whatever MCP servers contribute.

| group | tool | notes |
|---|---|---|
| read | `read_file` | line-numbered, range-capable |
| | `list_dir` | |
| | `find_files` | glob |
| | `search_code` | ripgrep |
| | `symbol_outline` | tree-sitter: file structure, symbol definitions |
| | `git_status` | status / diff / log / blame — read-only |
| write | `edit_file` | SEARCH/REPLACE, payload **inside** the normal JSON arguments — see §3 and §7; the spike measured zero escaping failures, so the non-standard channel bought nothing |
| | `write_file` | new files and full rewrites |
| | `move_file`, `delete_file` | separate from bash so permission rules can see them |
| run | `run_command` | PowerShell, with timeout |
| | `background_task` | start / poll / stop long-running processes |
| meta | `todo_write` | visible plan |
| | `ask_user` | question with options, instead of guessing |

---

## 6. Feature set (all of it — sequencing is an implementation-plan concern)

Chat with streaming and interrupt · the 14 tools · permission system with all four modes ·
plan mode · per-file diff review · session persistence and resume · auto-compaction ·
`PROJECT.md` project memory (hierarchical, auto-loaded) · custom slash commands ·
todo list · event hooks · auto-formatter after edits · MCP client for local servers ·
live server status.

**Reserved, not in the first build:** web fetch / search (one tool + one permission rule —
drops in without rework), sub-agents, LSP integration.

**Impossible with the current setup:** images and screenshots. Qwen3.6 is natively
image-text, but this GGUF has **no vision tower**; it would need a separate mmproj file
and VRAM that isn't available. This is the one genuine gap versus Claude Desktop.

---

## 7. Spike results (2026-08-02)

Run: `spike/grammar_spike.py`, report in `SPIKE-RESULTS.md` / `.json`.

**Confirmed — law 1, emphatically.** On a ~14.9k-token history: appending to the end took
**0.5 s**; changing one word near the *start* of the same history took **27.7 s**. Ratio
**56.5×**. Any context strategy that rewrites history mid-session is disqualified, exactly
as designed.

**Confirmed — tool calls are already reliable.** 12 of 12 well-formed calls across two
experiments, arguments always valid JSON, and `<think>` never leaked into `content`
(thanks to `--reasoning-format deepseek`). Notably this was achieved **without supplying
any grammar of our own**: llama.cpp already builds a constraint grammar from the tool
schemas when `tools` is passed under `--jinja`. The headline mechanism of the design is
therefore free — we do not implement it, we rely on it.

**Confirmed — plan mode needs no enforcement layer.** With only read-only tools offered
and `tool_choice=required`, 6 of 6 runs stayed inside the offered set. Restricting the
tool list *is* the enforcement.

**Confirmed — the two-call split is free.** The second call of a turn cost 1.7 s for 78
generated tokens, i.e. the prefix was served from cache. Per-phase sampling costs nothing.

**Thinking is adaptive, and the spread is large.** ~66 tokens on a tool-selection step
(≈1 s) versus ~1900 on a file-editing step. "Always on" is cheap for mechanical steps,
which was the worry that drove the original adaptive-thinking recommendation — that worry
is resolved. But see below.

### The dominant failure mode: thinking runaway (`spike/edit_probe.py`)

Experiment 4's poor edit rate was **not** a tool-call problem. On a hard edit the model
spirals: it keeps reasoning and never commits.

| conditions | tool call emitted | thinking, median | wall, median |
|---|---|---|---|
| `max_tokens=2000`, `tool_choice=auto` | 1/5 | 1587 tok | 30 s |
| `max_tokens=8000`, `tool_choice=auto` | 2/5 | **5591 tok** | **119 s** |
| `max_tokens=8000`, **`tool_choice=required`** | **4/5** | **1262 tok** | **24 s** |

Raising the cap does not fix it — it buys a longer spiral (one run reasoned for 6119
tokens and still emitted nothing). **`tool_choice=required` is the lever**: denying the
model the option of merely talking cuts median thinking by 4× and doubles the completion
rate. This is almost certainly a large part of why existing tools "just sit there thinking"
on hard tasks — from the outside a truncated spiral is indistinguishable from a hang.

### The cause: temperature (`spike/temp_probe.py`)

Isolated with everything else held fixed — same task, same prompt, `tool_choice=required`,
`max_tokens=4000`, n=6 per arm:

| arm | usable edits | truncated | thinking range | wall max |
|---|---|---|---|---|
| temp **0.1**, standard prompt | **3/6** | 3 | 1149 … **3382** | 73 s |
| temp **0.6**, standard prompt | **6/6** | 0 | 1192 … 1991 | 47 s |
| temp **0.6** + anti-deliberation prompt | **6/6** | 0 | 1223 … 1695 | **41 s** |

At 0.1 the thinking length is **bimodal**: either ~1.2–1.7k tokens and success, or 3.2k+
and a truncated spiral. There is no middle. At 0.6 the tail is simply absent. Across all
four spikes: ~25 runs at 0.6 produced no runaway at all; ~49 runs at 0.1 produced them
routinely. Per-arm n is small, but the aggregate signal is consistent.

**Production config: temp 0.6 / top-p 0.95 / top-k 20, plus a system prompt that tells the
model to commit rather than re-check, plus `tool_choice=required`.** The last arm has both
the best completion rate and the tightest latency spread, which matters more than the
median for an interactive tool.

Note the wider lesson, which is probably why competing tools are unstable on local models:
lowering temperature for "reliable structured output" is a habit carried over from cloud
APIs, where it is harmless. On a 3B-active model it switches on exactly the failure mode it
was meant to prevent.

Production requirements this yields:

1. Every step that should end in an action is issued with `tool_choice=required`.
2. Sampling stays at Qwen's recommended values; never lower temperature for structure.
3. `max_tokens` must budget for thinking, and `finish_reason == "length"` must be handled
   by continuing, never treated as a failed step.
4. A per-step wall-clock ceiling with a visible countdown — a 120 s silent step is the
   single worst thing the UI can do. Expect ~35–40 s for a hard single-file edit.

### Edit format: validated, and simplified

Across every run that produced a call, **all 7 non-empty SEARCH anchors matched the file
byte-for-byte** — none needed whitespace-tolerant matching, and there was not one escaping
error despite a file full of regexes and `@""` strings. SEARCH/REPLACE is confirmed, and
the payload can ride inside the normal JSON arguments. Whitespace-tolerant matching stays
in as a safety net, not as a load-bearing part.

The real argument defect is different: on a *trivial* file, 2 of 5 runs emitted an **empty
`search_text`** — schema-valid, semantically useless. Tools must validate meaning.

## 8. Open items

- ~~Finish the edit-reliability probe and settle whether SEARCH/REPLACE anchors need
  whitespace-tolerant matching (and therefore whether payload-outside-JSON buys anything,
  given the grammar already guarantees valid escaping).~~ **Closed** by the edit probe,
  recorded in §7: all 7 non-empty anchors matched byte-for-byte, there were no escaping
  failures, the payload rides inside the normal JSON arguments, and whitespace-tolerant
  matching ships as a safety net rather than as a load-bearing part.
- Firewall rule for port 8080.
