# Sharing changes and fixing conflicts

Git is the source of truth. Your code lives in your checkouts and moves through your own remote with your own credentials. The Kovan server coordinates sessions; it does not store source code.

## Worktrees

A session you join gets its own Git worktree, and so does each subagent, so your main checkout is left alone. If the main checkout is already on the session's branch, Kovan uses it as it is.

Git cannot check the same branch out twice. When that would be needed, Kovan uses a session branch named `kovan/session-<id>` instead.

A worktree keeps work apart. It is not a security boundary.

If you switch branches by hand inside a session worktree, the session pauses and a banner offers to switch back or resume. Agents wait, sync stops, and the team sees it in the activity feed.

## Snapshot sync

While a session is live, saved changes are grouped every five seconds into a snapshot commit and pushed to a shadow ref on your remote:

```
refs/kovan/snapshots/<session>/<person>
```

The push uses your own Git credentials. The server only records the commit, the ref and the time. Your teammates' machines fetch the snapshot and apply it to their checkout of the session branch, so everyone in the session sees the same files.

Ordinary commits travel the same way: when a teammate's branch moves ahead, your checkout follows it.

## Before a snapshot is applied

Kovan compares three versions: the last snapshot you received (or the shared base commit), your file, and theirs.

- Only they changed the file: you get their version.
- You both changed different lines: the changes are merged.
- You both changed the same lines: **both versions are kept**.

Nothing is overwritten silently. Snapshots that arrive while your agent's turn is running are applied when the turn ends.

## Conflicts

A file with two versions shows a **2 versions** chip, and the Explorer has a **Conflicts** tab that lists them. For each one you can:

- **Compare** the two versions side by side,
- **Keep mine**, or
- **Take theirs**.

When the files match again the chip goes away on both sides. If a change arrives on disk while you have unsaved edits, your edits are kept as the second version when you save.

## Turning sync off

Each workspace has a **Git sync** switch. With it off, nothing is pushed or applied automatically, and you sync with ordinary Git.

## Sync paused

If your branch cannot be pushed, a **Sync paused** banner explains which of these happened and offers **Retry**:

- your Git credentials were rejected,
- a branch rule on the remote blocked the push, or
- the remote could not be reached.

See [Troubleshooting](/docs/troubleshooting/) for what to do in each case.

## Subagents

A subagent starts from a snapshot of your lane in its own worktree, and your lane keeps going. Its work is merged into your lane once, and only if it applies cleanly and passes `git diff --check` and the **Required Checks** in `KOVAN.md`. If it conflicts or a check fails, your lane is untouched and the subagent's work stays available to review, check again or discard.

## Finishing

A session ends the ordinary way. Commit and push from Source Control, then choose **Create pull request**. When the pull request is merged the session is complete and moves to History with its final diff.

## Interrupted actions

If a command with outside effects, such as a push or a deploy, is cut off part-way, Kovan never retries it by itself. It records **Outcome unknown** with what was sent, and a person records whether it went through.
