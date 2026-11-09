---
name: reading-list
description: Put a file or URL on the person's Herdr reading list (rl add) when you produced something they should read, look at or decide on - a deliverable, a report, a result, a plan waiting for their call. Use it instead of only pasting a path in chat. Not for routine progress or files you only touched along the way.
---

# Reading list

The person keeps a reading list in Herdr (the `readlist` mod). Anything you add shows up there
with a toast; they walk the list when they have time, preview each item and open it in its app.
Each item says who added it and why. Treat the list as their inbox for your output: what is on it
should be worth their attention.

## When to add

Add what the person should read, look at or decide on:

- **deliverables**: the document, page, image or build they asked you for;
- **reports**: a review, an investigation, a summary, a comparison you wrote for them;
- **results**: the outcome of a task, such as a test or benchmark report, a screenshot showing a
  change works, a generated file;
- **decisions**: a plan or design that waits for their call.

A file you changed and want them to look at again goes on again: adding the same path moves it to
the top as unread, with your new note.

Do not add:

- routine progress: "started", "still working", a status line, a log of what you did;
- every file you edited, scratch files, intermediate output, or each save of something you are
  still working on (add it once, when it is ready);
- anything you already put on the list and have not changed.

One good item with a clear note beats five without one.

## rl

```sh
rl add <path|url> --note "what it is and what you want"   # prints the item id
rl add <path|url> --kind result --note "..."              # the outcome of a task
rl add <path|url> --kind fyi --note "..."                 # worth knowing; no toast
rl ls [--unread | --done | --all] [--json]                # what is on the list
rl done <path|url|id>                                     # you know the person handled it
rl rm <path|url|id>                                       # take your item back off
```

Pick the kind for what you want from the person:

- `review` (the default): please read this, and maybe act on it or answer;
- `result`: here is what the task produced; read it when you get to it;
- `fyi`: worth knowing, nothing to do; arrives without a toast.

Write the note for someone who has not followed your work: one or two short sentences saying what
it is and what you want from them. Name the part that matters.

- Good: `--note "Rollout plan v2: step 3 now migrates in two passes. Need your OK on the downtime window."`
- Good: `--kind result --note "Benchmark after the cache fix: p95 down from 410 to 120 ms; table on page 2."`
- Not useful: `--note "Done"`, `--note "plan.md"`, `--note "Updated the file"`.

Who added the item:

- Inside a Herdr terminal, `rl` records which agent added it on its own; you need not pass anything.
- Elsewhere (a script, a scheduled job, a remote shell outside Herdr) pass `--from NAME` with a name
  the person will recognise: `--from "nightly backup check"`. Without it the item says your user
  name and the calling program.

Other options and details:

- `--title` overrides the title (default: the file name, or a markdown file's first `# ` heading).
- Paths may be relative; `rl` stores the real absolute path. The file or folder must exist. URLs
  must start with `http://` or `https://`.
- `--if-new` adds only if the path or URL is not on the list yet, and otherwise leaves its item as
  it is (for a job that may run more than once).
- On Windows `rl` takes the same commands from PowerShell, cmd.exe and Git Bash.

If `rl` is not found, the person can install it from the reading list (its Install rl button, or
`herdr-app do readlist.install-rl`). Do not install it yourself; use the fallback below.

## Without rl

Write one JSON file per item into `$READING_LIST_DIR/items/` (default
`~/.local/state/reading-list/items/`, on Windows `%LOCALAPPDATA%\reading-list\items\`; create it
if missing). Write it under a temporary name that
starts with a dot, then rename it to `<id>.json`, so the list never reads half a file.

```json
{
  "v": 1,
  "id": "3f2a9c1e5b7d4a60",
  "path": "/absolute/real/path/to/plan.md",
  "url": null,
  "title": "Rollout plan",
  "note": "Revised rollout; step 2 changed.",
  "kind": "review",
  "added_at": "2026-11-08T18:42:11Z",
  "adds": 1,
  "by": { "terminal": null, "app": null, "name": null, "space": null, "tab": null, "cwd": null, "from": "your-name" },
  "size": null,
  "mtime": null,
  "done_at": null
}
```

- `id` is the first 16 hex characters of the SHA-256 of the real absolute path (or of the URL):
  `printf '%s' "$path" | shasum -a 256 | cut -c1-16`. Using the same id for the same file is what
  makes a second add replace the first. On Windows the path is written as `rl` writes it
  (`C:\Users\me\plan.md`: drive letter upper case, each name as it is on disk), and in PowerShell
  the id is `[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($path))).ToLower().Substring(0, 16)`.
- Exactly one of `path` (absolute) and `url` (`http(s)://`) is set; the other is `null`.
- `added_at` is the time now in UTC; `v` is `1`; `kind` is `review`, `fyi` or `result`.
- `by.from` names you, as `--from` would.
- `title`, `note`, `size` and `mtime` may be `null`. Never write anything else in that folder.
