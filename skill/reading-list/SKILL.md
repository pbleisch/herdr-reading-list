---
name: reading-list
description: Put a file or URL on the person's Herdr reading list (rl add) when you made something they should read, look at or decide on - a plan, a report, a screenshot, a generated page. Use it instead of only pasting a path in chat. Not for files you only touched along the way.
---

# Reading list

The person keeps a reading list in Herdr (the `readlist` mod). Anything you add shows up there
with a toast; they walk the list, preview each item and open it in its app. Each item says who
added it and why.

## When to add

Add only what the person should read, look at or decide on:

- a plan, design, report or summary you wrote for them;
- a screenshot, chart or generated page that shows a result;
- a document you changed and want them to look at again (adding the same path again moves it to
  the top as unread).

Do not add every file you edited, logs, or intermediate output. One good item with a clear note
beats five without one.

## rl

```sh
rl add <path|url> --note "why they should read it"     # prints the item id
rl add <path|url> --kind fyi --note "..."              # no toast; for "worth knowing"
rl add <path|url> --kind result --note "..."           # the outcome of a task
rl ls [--unread | --done | --all] [--json]             # what is on the list
rl done <path|url|id>                                  # you know the person handled it
rl rm <path|url|id>                                    # take your item back off
```

- `--kind` is `review` (the default: please read this), `fyi` (no toast) or `result`.
- `--title` overrides the title (default: the file name, or a markdown file's first `# ` heading).
- Paths may be relative; `rl` stores the real absolute path. The file or folder must exist. URLs
  must start with `http://` or `https://`.
- Inside a Herdr terminal, `rl` records which agent added the item on its own. Elsewhere pass
  `--from NAME`.
- The note is one or two short sentences: what it is and what you want from the person.

If `rl` is not found, the person can install it from the reading list (its Install rl button, or
`herdr-app do readlist.install-rl`). Do not install it yourself; use the fallback below.

## Without rl

Write one JSON file per item into `$READING_LIST_DIR/items/` (default
`~/.local/state/reading-list/items/`, create it if missing). Write it under a temporary name that
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
  makes a second add replace the first.
- Exactly one of `path` (absolute) and `url` (`http(s)://`) is set; the other is `null`.
- `added_at` is the time now in UTC; `v` is `1`; `kind` is `review`, `fyi` or `result`.
- `title`, `note`, `size` and `mtime` may be `null`. Never write anything else in that folder.
