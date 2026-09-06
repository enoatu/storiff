# storiff

A big diff gives you no place to start.
Let AI split it into steps by intent, and read one step at a time.

[日本語](README.ja.md)

```
run /storiff
  ↓
read the diff, number every changed line          prep
  ↓
group those numbers into steps by intent          Claude
  ↓
a URL comes back. start reading right away        serve
  ↓
narrations fill in behind you                     fill
  ↓
comment on a line that bothers you
  ↓
Claude answers in the conversation
```

## How this differs from crit

storiff builds on the idea behind [crit](https://github.com/tomasz-tomczyk/crit).
Grouping a diff into chapters and reading them in order is the same. These parts differ.

| | crit | storiff |
| --- | --- | --- |
| Unit of grouping | hunk | change id, one per changed line |
| Narration | one summary line per chapter | a narration per step, filled in behind you |
| Lines owned by another step | blend in when you expand context | always told apart by change id |
| Where you read | browser | browser and neovim |
| How far you read | | remembered, so you can continue |
| Kept out of a chapter | `support[]` with a reason | |

### Grouping by line lets one hunk be split

crit groups by hunk, so a whole `@@` block lands in one chapter.
storiff numbers every changed line, so part of the same block can belong to a different step.

Intent does not line up with hunk boundaries. One block often holds both the real fix and some tidying done along the way.

### Expanding context does not pull in another step's lines

In crit, expanding around a hunk brings those lines in as unchanged context.
Even a line another chapter added carries no mark saying it changed.

storiff numbers every changed line and knows which step owns it,
so even when you widen the view you can tell "another step added this".

### Narrations fill in while you read

A crit chapter carries one summary line, and you wait for it.
storiff holds a narration per step and writes each one back the moment it is done.
While you read the first step, the later ones fill in.

### Read them as real files in neovim

With [nvim-storiff](https://github.com/enoatu/nvim-storiff) you can read the same story in neovim.
It opens the real files, so `gd` and `gr` still jump to definitions and references.

## Install

Install it as a Claude Code plugin. Add the marketplace once, then install.

```
/plugin marketplace add enoatu/storiff
/plugin install storiff@storiff
```

After that `/storiff` works from any project (use `/storiff:storiff` if the name collides).
No npm, no symlink. The plugin ships storiff.js, the skill and the docs.

Per-session files (changes.json, comments.json) go under `~/.storiff/<timestamp>/`.

## Usage

1. Run `/storiff`
2. A URL comes back right away. Open it and start from step 1. Narrations fill in behind you, so a step that is not ready says "preparing". If you read this diff before, a "continue" button appears
3. As you read, comment on a line, on the step, or on the whole story. Resolve the ones you are done with
4. After fixing code, press "pull in changes" to follow the diff
5. Press "review done"
6. Claude answers your comments in the conversation

## What helps while reading

### The overview

Before following the steps one by one, you get a look at the whole diff.
AI writes an overview along with the story, and the viewer shows it before the diff on the first step.

- Summary what was wrong and how it was solved
- Key changes only the changes a reader wants to know, as bullets
- Risks what breaks widely if it breaks, and what was left undone

A title alone does not tell you how big the diff is or what you are reading it for.
Reading this first makes it harder to lose track of where the current step sits.

### Risks per step

The overview's risks are one list for the whole diff, so you cannot tell which step they are about.
So a step can carry its own `risks`. Opening that step shows them in a warning-colored box before the diff.
Mixed into the narration they get skipped, so they live in their own box.

The subagent that writes the overview writes these.
It is the only pass that reads the whole diff. `fill`, which writes one narration per step, only reads that step's diff,
so it cannot notice anything that needs the whole picture.
Steps with nothing risky get none. If every step had one, none would be read.

### Narrations fill in while you read

Draft narrations are empty, and `node storiff.js fill <dir>` fills them.
One `claude -p` per step, several at a time.

What matters is not waiting for all of them. Each one goes back into `steps.json` the moment it is written.
The viewer re-fetches every 3 seconds and redraws only what changed, so later steps fill in while you read the first.

On a 36-step diff here, the first step became readable after 24 seconds, and all 36 were filled after 442 seconds.
The reader waits only for those first 24 seconds. The rest happens behind them.

A narration is capped at 150 characters.
A long, fluent explanation leaves the reader feeling they understood without a chance to check.
What was done is visible in the diff, so it stops after a sentence or two and spends the rest on why.

Each child process gets only its own step's diff. `context.txt` and `hints.txt` are passed as paths, not contents.
Reading everything stretches the time per step.

- A step that is not filled yet says "preparing". Leaving it blank looks broken. A step titled "fix N" is exempt
- Step titles stay as prep wrote them. Rewriting them would shuffle the outline while you read
- Steps that already have a narration are left alone. Anything you rewrote by hand stays
- Filled from the first step onward, because that is where readers start
- Stopping partway keeps what was written. Running it again fills only the rest
- Where `claude` is not installed it is skipped quietly and narrations stay empty

Pulling in a diff while `fill` is running can leave a fresh narration with nowhere to go.
`prep` reports how many it carried over and how many were lost.

### Continue where you left off

A big diff does not fit in one day.
How far you read is kept in `<dir>/progress.json`, so closing it and opening it tomorrow does not mean hunting for your place.
It lives on the server, so another browser or another machine continues too.

- It always opens at step 1. It only offers a "you read up to step 3" button, and never jumps on its own. Someone who wants to reread from step 1 should not be pushed
- Finished steps turn green in the outline. The count is not shown. Printing what the outline already shows would take space above the diff
- Only the step number is remembered. Following a diff never renumbers existing steps, so positions hold even as steps are added
- Steps still preparing have no narration yet, so they do not count as read

### A small diagram per step

A step whose call order or state transitions are hard to follow gets a small diagram of just what that step touches.
It is not an architecture diagram, so it keeps to a few nodes.

Diagrams are held as Mermaid flowchart source and the viewer builds the SVG itself.
No drawing library is loaded, so diagrams work offline.
An unreadable diagram is simply hidden and the diff keeps rendering.

```
flowchart LR
  handler[deleteUser] -->|id| check{in use?}
  check --> db[delete the record]
```

## Comments

### Scope and resolving

Two or three rounds of review and "already fixed" becomes impossible to tell apart, so the comment list only grows.
So each comment can be resolved, and resolved ones are hidden by default.
Only hidden, with the button reading `show 3 resolved`, so nothing looks deleted.

A comment that gets a reply goes back to unresolved. Otherwise a new reply stays buried under the hidden ones.
To reply without reopening it, use `--keep-resolved`.

```
node storiff.js reply <dir> <number> "<body>" --keep-resolved
```

There are three scopes.

- line "why is this line written this way"
- step "this step took the wrong approach". With a story, this is the most natural unit
- story "the split itself is wrong"

The two that are not tied to a line get a box before the diff as soon as one exists. No box when there are none.
Two empty boxes would push the diff down the moment you open it, out of the part you most want to see.

### Comments that lost their line

Fixing code and pulling in the diff moves the line a comment points at.
A line-number map alone cannot follow it, so the text of the target line is remembered when the comment is written,
and comments the map could not carry are traced by that text.
When two or more lines in the same file share that text, there is no way to tell which one it was, so it is not traced.

A comment that still cannot be found is kept, with a note above it saying the original line was not found.
Being told it might point somewhere else lets the reader judge; being told it is gone does not.
The note disappears if the line comes back on a later pull.

## How a story is built

### Change ids and steps

`prep` reads the current working diff and numbers every changed line with a change id.
Claude groups those ids into steps by intent.

No change id belongs to two steps, and every change id lands in exactly one.
So all the steps together are exactly the diff you asked for.

### The draft split

Having AI work out the split from nothing gets slower as changed lines grow.
git diff already cuts the diff into `@@` blocks, and their count is the same order as the step count AI produces.
So `--with-draft` makes prep build just the split from those blocks and write it into `steps.json`.

```
node storiff.js prep <dir> --with-draft
```

- One block, one step. Small neighboring blocks are merged, oversized ones are split
- Never merged across files
- Titles are placeholders built from the file name and a counter, like `the 2nd change in storiff.js`. Narrations are empty and `fill` writes them later
- Every change id lands exactly once, so `check` passes as is

It is off by default, so without the flag AI works out the split itself.
An existing `steps.json` is never overwritten, since that would get in the way of following a diff.

Blocks are just nearby changed lines, not units of intent, so the draft is only a starting point.
Regroup it to match intent.

### How changes connect

Deciding where to split is hard, so prep pulls hints out of the changed lines into `hints.txt`.
Lines like "change id 12 defines fetchUser in src/api.js, and change ids 45, 46 use it" line up there,
and Claude uses them to decide step boundaries.

No external tool, no npm. It goes by how names look.
JavaScript, TypeScript, Python and Go are covered; other languages are skipped quietly.
They are only hints, so a story can be built with none.

### Material for the why

Diff text alone only tells you what was done, which makes narrations restate the code.
So writing out the diff also gathers material for intent into `context.txt`.

- The branch name and the bodies of the commits in that diff
- Issue numbers picked out of the branch name and commits (`#12`, `ABC-123`)
- Where `CLAUDE.md`, `AGENTS.md` and `README.md` sit near the changed files
- Only with `--with-remote`, the PR and issue bodies and comments read through `gh`

Everything up to there stays in your local git.
GitHub is only queried with `--with-remote`, or with `{"with_remote": true}` in `~/.storiff/config.json`.
It still works with whatever it could gather when `gh` is missing, not logged in, offline, or the remote is not GitHub.

### Checking

`node storiff.js check <dir>` checks `steps.json`.
A missing change id, a duplicated one, or an unknown file all come back ng.
This is the only place that confirms all the steps together are the diff you asked for, so run it after editing `owns`.

It checks diagram syntax at the same time: unreadable lines, the old `graph` opener, `->` and `-->>` arrows, and a node name that repeats its label.

## Reading in neovim

With [nvim-storiff](https://github.com/enoatu/nvim-storiff) you can read the same story in neovim.

```
:Storiff
```

It opens the real files, so `gd` and `gr` work.
The outline and narration sit in floating windows on the side, and it opens in its own tab, so the windows you already had stay as they are.
You can write comments from neovim too.

## Settings

`~/.storiff/config.json` holds defaults.

| Name | What it decides |
| --- | --- |
| `host` | the host serve listens on |
| `exclude` | file patterns to leave out. no lines are kept, only the name and line count show up in the support step |
| `generated` | patterns treated as generated files. moved into support when the draft is built |
| `with_remote` | whether GitHub PRs and issues are used as material. false by default |

```json
{"host": "0.0.0.0"}
```

With this, serving without `--host` is reachable from outside by host name.
A `--host` on the command line wins over it.
`0.0.0.0` shows the diff and comments to everyone who can reach you, so keep it to temporary use.

## Files

| File | Role |
| --- | --- |
| `storiff.js` | A single Node file doing prep (diff analysis), fill (writing narrations back), check, serve (the viewer) and reply |
| `docs/story-schema.md` | The data contract |
| `skills/storiff/SKILL.md` | The `/storiff` skill definition |
| `.claude-plugin/plugin.json` | Plugin definition |
| `.claude-plugin/marketplace.json` | Marketplace definition |

## Data contract

changes.json, steps.json, story.json, the HTTP API, and the finer rules of each command are in [docs/story-schema.md](docs/story-schema.md).
