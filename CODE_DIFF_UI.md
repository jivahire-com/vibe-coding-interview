# Starter → Final Code Diff — API & UI rendering guide

A recruiter reviewing a graded session wants to see **what the candidate
actually changed**: the starter variant code that was handed to them vs the
final code they submitted, shown as a git-style diff. This document describes
the backend contract (already implemented) and how to render it. **No UI is
implemented yet** — this is the spec for whoever builds the panel.

The same payload is reachable two ways:

| Caller | Endpoint | Auth |
| --- | --- | --- |
| Direct (this service) | `GET /api/v1/sessions/{session_id}/code-diff` | `X-Admin-Token` header |
| Recruiter dashboard | `GET /api/v1/sidecars/interview/sessions/{session_id}/code-diff/` | recruiter JWT (org-scoped) |

The recruiter route is a thin proxy in `recruiter-backend` that injects the
admin token and the caller's `org_id` — see that repo's
`documentation/code_diff_viewer.md`. The response body is identical; build the
UI against the shape below regardless of which route you call.

## Where the two sides come from

The candidate's whole workspace lives on the GitHub branch
`interview/<session_id>`. Its commit history is:

```
<provisioning commits>   ← variant starter, .jivahire answer key stripped   ── "starter"
auto: 2025-06-22T10:03Z  ← candidate's 3-min auto-commits
auto: 2025-06-22T10:06Z
…
auto: 2025-06-22T10:48Z  ← HEAD                                            ── "final"
```

The backend diffs `base..HEAD`, where `base` is the newest **non-**`auto:`
commit (`candidate_base()` in `grader/git_ops.py`) — i.e. the workspace exactly
as delivered. So the diff is the candidate's own work only; setup commits never
show up as candidate changes. (See `code_diff.py`.)

## Response schema

```jsonc
{
  "session_id": "sess-abc123",
  "challenge_id": "cpp-thread-safe-cache",
  "branch": "interview/sess-abc123",
  "source_ref": "main",              // or "variant/org-7/strict-locking"
  "candidate_email": "cand@example.com",
  "status": "graded",
  "submitted_at": 1750590000,
  "base_sha": "9f2a…",               // starter side; the git empty-tree SHA if no baseline found
  "head_sha": "1c8e…",               // final side
  "files": [
    {
      "path": "include/lru_cache.hpp",
      "old_path": null,              // set only when status == "renamed"/"copied"
      "status": "modified",          // added | modified | deleted | renamed | copied
      "starter": "…full file text at base…",   // null if added / binary / truncated
      "final":   "…full file text at HEAD…",    // null if deleted / binary / truncated
      "starter_binary": false,
      "final_binary": false,
      "truncated": false,            // true when a side exceeded 200 KB (text omitted)
      "additions": 42,               // null for binary files
      "deletions": 7,
      "patch": "diff --git a/include/lru_cache.hpp …"   // unified diff for this file only
    }
  ],
  "excluded": [                       // paths deliberately kept out of the diff
    { "path": ".jivahire/telemetry.jsonl", "reason": "internal" },
    { "path": "build/CMakeCache.txt",      "reason": "generated" }
  ],
  "combined_patch": "diff --git …"   // the whole diff over the *kept* files, one string
}
```

### `excluded` — what's filtered and why

The diff shows candidate **source** only. These are dropped (and reported here so
the UI can show "N artefact files hidden" rather than silently omitting them):

- `internal` — the `.jivahire/` directory (integrity marker, ingested telemetry,
  challenge metadata). Never candidate code.
- `gitignored` — matched the challenge repo's own `.gitignore`.
- `generated` — a build/dependency artefact (`build/`, `node_modules/`,
  `__pycache__/`, …) committed despite not being source. Fallback for repos that
  ship no `.gitignore`.

`combined_patch` and `files` both already exclude these — no client-side filtering
needed.

### Status / error responses

| Status | Meaning | UI action |
| --- | --- | --- |
| `200` + `files: []` | Candidate changed nothing | Show "No changes — candidate submitted the starter unmodified." |
| `409` | Session hasn't started (still `pending`) | Hide/disable the tab; there's no workspace yet |
| `404` | Unknown session, or another org's | Generic "not found" |
| `502` | Branch unreadable on GitHub (deleted / token) | "Couldn't load the candidate workspace. Try again." |

## Rendering — pick one of two paths

### Path A (fastest): drop `combined_patch` into a unified-diff renderer

[`diff2html`](https://github.com/rtfpessoa/diff2html) takes a raw `git diff`
string and produces line-by-line or side-by-side HTML with syntax highlight —
no per-file assembly needed.

```ts
import { Diff2HtmlUI } from 'diff2html/lib/ui/js/diff2html-ui';

const { combined_patch } = await fetchCodeDiff(sessionId);
const ui = new Diff2HtmlUI(el, combined_patch, {
  drawFileList: true,
  matching: 'lines',
  outputFormat: 'side-by-side',   // or 'line-by-line'
});
ui.draw();
ui.highlightCode();
```

This is the recommended default for the recruiter panel — one call, both
layouts, file list for free.

### Path B (richest): per-file side-by-side with Monaco

When you want an editor-grade view (collapsible regions, intra-line highlight,
copy buttons), drive a Monaco diff editor per file from `starter`/`final`:

```ts
for (const f of files) {
  if (f.truncated || f.starter_binary || f.final_binary) { renderBadge(f); continue; }
  const editor = monaco.editor.createDiffEditor(mount, { readOnly: true, renderSideBySide: true });
  editor.setModel({
    original: monaco.editor.createModel(f.starter ?? '', langFor(f.path)),   // added → ''
    modified: monaco.editor.createModel(f.final   ?? '', langFor(f.path)),   // deleted → ''
  });
}
```

CodeMirror 6's `@codemirror/merge` `MergeView` works equivalently if the app
already ships CodeMirror.

## Edge cases the UI must handle

- **Added file** — `starter` is `null`, `status: "added"`. Render the original
  pane empty; the whole file is green.
- **Deleted file** — `final` is `null`, `status: "deleted"`. Modified pane empty.
- **Renamed file** — `old_path` holds the previous name; show `old_path → path`
  in the file header. The `patch` already accounts for the rename.
- **Binary** (`*_binary: true`) — don't try to render text; show
  "Binary file changed (+N/−M)" using `additions`/`deletions` (which may be
  `null` for binaries — fall back to "Binary file changed").
- **Truncated** (`truncated: true`) — a side was > 200 KB; text omitted. Offer
  the `patch` (always present) and a note that the full file is too large to
  inline.
- **Empty `files`** — see the table above.

## Suggested placement

Add a **"Code diff"** tab/panel to the session-details view, next to the
existing "View tests" panel. Both are on-demand, recruiter-only reviews of a
graded session — fetch the diff lazily when the tab is first opened (the payload
carries full file contents, so don't preload it with the session poll, the same
way test source is kept out of `GET /sessions/{id}`).
