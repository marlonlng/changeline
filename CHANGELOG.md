# Changelog

## 0.3.0

- Diff viewer: two side-by-side editors that scroll together with curved bands between the changes, Synchronize Scrolling, highlight words / lines / split changes / characters / none, ignore whitespace and empty lines or formatting, soft wraps, line numbers and white spaces on demand, Annotate with Git Blame, Open in New Window, commit details for history diffs, a Diff Settings menu
- Three-way merge window rebuilt with three linked panes and bands to the result, ignore whitespace, highlight modes and soft wraps
- Change popup in the editor gutter: Rollback Lines, Show Diff, Copy and Move to Another Changelist
- Partial changelists follow edits: new changes go to the active changelist, edited chunks keep theirs
- Git log: all repositories in one log with root names, diff preview, view options grouped as in JetBrains (Show, Highlight, Graph Options), long edges with arrows, first parent, no merges, sort by date or topologically, highlight of not cherry-picked commits
- Branches popup: Group by Prefix folders, worktrees, Checkout and Update, Checkout in New Worktree
- Restore workspace on branch switching (`changeline.branches.restoreWorkspace`)
- Clean working tree before update, smart checkout and rebase using stash or shelf (`changeline.saveChanges`)
- Commit message: completion of words and symbols from the changed files, issue links (`changeline.issueNavigation`), wrap when typing reaches the right margin, Generate Commit Message with a VS Code language model
- Commit options: Cleanup (fix all and optimize imports) before commit, Run advanced checks after a commit is done
- Pull and merge requests: pending reviews (Start Review, Submit Review), resolve threads, apply suggestions, mark files as viewed, edit title, description, reviewers, assignees and labels, Ready for Review, review comments in the editor while the branch is checked out

## 0.2.0

- Diff viewer: change markers in the scrollbar (green added, blue modified, gray deleted); clicking a marker jumps to the change
- Fixed line status markers on ignored files such as `.env.local`, which showed every line as added; markers now only appear for files git has in HEAD (or in the index in staging area mode)

## 0.1.1

- Fixed the merge window title on Windows, which showed the full path instead of the file name
- Dialogs from the Commit tool window now open as overlay at the default sidebar width instead of falling back to an editor tab

## 0.1.0

First release.

- Commit tool window: changelists, include checkboxes, partial commits per chunk, staging area mode, amend, message history and inspections, commit options, Commit and Push
- Git log with commit graph, branches pane, filters, details, full commit / file / branch context menus
- Branches popup with favorites, recent branches and all branch actions; smart checkout / merge
- Update Project, Pull, Fetch, Push dialog (force with lease, protected branches, rejected push handling)
- JetBrains-style diff viewer with chunk rollback, partial commit checkboxes and stage/unstage per chunk
- Conflicts dialog and three-way merge window
- Interactive rebase dialog, reword, fixup, squash, drop, undo commit
- Shelf with three-way unshelve, stash view and dialogs
- Annotate with Git Blame, file history, history for selection, compare with revision / branch
- Status bar branch widget, VCS operations popup, Git console, credential prompts
- Dialogs as modal overlay in the Git log and the Commit tool window; single-field dialogs as quick input
- English and German user interface
