# Feature parity with JetBrains IDEs

Reference: the Git integration of PhpStorm / IntelliJ IDEA (2024–2025), including the bundled GitHub and GitLab plugins.

**Evidence**

- **U**: unit test (`src/test/unit`)
- **I**: integration test against real temporary git repositories (`src/test/integration`)
- **E**: end-to-end test inside VS Code 1.143 on macOS and on Linux, through commands and the extension API (`src/test/e2e/suite.ts`)
- **V**: end-to-end test that clicks and types in the real VS Code window (webviews, quick picks, trees) through the DevTools protocol and checks the result in the repository (`src/test/e2e/ui.ts`)
- **S**: screenshot of the real VS Code window (`docs/screenshots`)
- **H**: webview checked in the browser preview harness (`test-harness`)
- **M**: API client tested against a mock GitHub / GitLab server
- **L**: API client checked read-only against the real public GitHub and GitLab APIs (`src/test/integration/hostingLive.test.ts`, skipped offline)
- **W**: Windows path logic unit-tested with `path.win32` (`src/test/unit/paths.test.ts`)

## Commit tool window

| JetBrains | Changeline | Evidence |
| --- | --- | --- |
| Local Changes tree, file status colors | *Commit* activity bar → Local Changes | E, S 01 |
| Changelists: new, edit (name + comment), delete, set active | Tree context menu, view toolbar | E, S 01 |
| Move to Another Changelist (F6), drag & drop | Context menu, F6, drag between lists | E |
| Partial changelists (chunks of one file in different lists) | ⇄ per chunk in the diff viewer; the file shows in each list | E, S 01–02 |
| Include checkboxes (file, directory, changelist) | Tree checkboxes | E, S 01 |
| Partial commit by chunk | Checkbox per chunk in the diff viewer; committed through a temporary index | I, E |
| Staging area mode (stage / unstage file or chunk) | `changeline.commit.useStagingArea` | I (index writes), E (stage and commit), H |
| Unversioned files: Add, Add to .gitignore, Delete | Context menu | E |
| Ignored files node | View menu → Show Ignored Files | E |
| Group by directory / repository | View toolbar → Group By | E (repository), V (directory) |
| Commit message editor, Amend, history (⌘M), commit template | Commit Message view | V, S 01, H |
| Message inspections (subject length, blank line) | Inline warnings | V, H |
| Author, Sign-off, Run Git hooks, GPG signing | Options (gear) | I (args), V (options panel) |
| Before commit: Reformat code, Optimize imports, Analyze code, Check TODO, Run tests | Options (gear); the formatter, organize-imports action, problems and task of the workspace | E |
| Detached HEAD warning, CRLF warning (Windows) | Modal before commit | E |
| Commit / Commit and Push | Buttons, ⌘↩ / ⌥⌘↩ | E, V (Commit button), S 01 |
| Commit during merge / cherry-pick | Real index commit with MERGE_MSG prefill | I |
| Rollback with "Delete local copies of added files" | Rollback dialog | I, H |
| Shelve, Shelve Silently, Unshelve (merging with local changes), Recently Deleted, Import / Create patch | Shelf view | E (shelve, shelve silently, unshelve), S 07 |
| Stash, Unstash (pop / reinstate index / as branch), drop, clear | Stash view and dialogs | I, S 08 |
| Create Patch, Apply Patch (file selection, 3-way) | Commands, VCS popup | I |
| Line status gutter markers with rollback | Quick diff (on when built-in Git is off) | E (original resource) |

## Diff and merge

| JetBrains | Changeline | Evidence |
| --- | --- | --- |
| Side-by-side and unified viewer, syntax highlighting | Diff viewer | V, S 02, H |
| Highlight words, ignore whitespace, collapse unchanged fragments | Diff toolbar | V, H |
| » revert chunk, include checkbox, stage / unstage chunk | Diff gutter | V (revert, include), I (stage / unstage index writes), H |
| Next / previous difference (F7), next / previous file | Toolbar, keys | V, H |
| Jump to source (F4), open in native diff editor | Toolbar, F4 in Local Changes | E |
| Compare with Clipboard | Editor → Git menu | E |
| Conflicts dialog (Accept Yours / Theirs, Merge…) | Opens on conflicts | E, V, S 11 |
| Three-way merge window with »/«/✕, Apply Non-Conflicting Changes, Resolve Simple Conflicts, Accept Left/Right | Merge window | U, V, S 12, H |

## Git tool window: Log

| JetBrains | Changeline | Evidence |
| --- | --- | --- |
| Commit graph, branch / tag labels, author, date, hash columns | Panel *Git* → Log | U, V, S 03 |
| Branches pane with favorites, groups, incoming/outgoing | Log left pane | V (navigate to a branch), S 03 |
| Filters: text/hash (regex, case), branch, user, date, paths | Filter bar | I, V (text), H |
| Highlight current branch / my commits, collapse linear branches | View options | U, V |
| Commit details, changed files tree, merge commit parent selection | Right pane | V, H |
| Commit context menu (cherry-pick, revert, reset, undo, edit message, fixup, squash into, squash commits, drop, interactive rebase from here, push up to here, new branch / tag, checkout revision, show repository at revision, compare with local, create patch, copy revision, go to parent / child, open in browser) | Right-click on a commit | I (operations), E, V (menu context of the rows), H |
| Changed file context menu (show diff, compare with local, edit source, open repository version, revert / cherry-pick selected changes, history up to here, Get, annotate revision, open in browser) | Right-click on a file | E |
| New Log tab | Log toolbar (+), branch → Show in New Log Tab | E |
| Console | *Show Git Console* | E |

## Branches, remotes, history

| JetBrains | Changeline | Evidence |
| --- | --- | --- |
| Branches popup (recent, local, remote, tags, favorites, search) | Status bar branch | V, S 04 |
| Checkout (smart / force), new branch, checkout and rebase, compare, diff with working tree, rebase onto, merge into, pull using rebase / merge, update, push, rename, edit tracking, delete with Restore | Branch actions | I, E, V (actions list, compare, New Branch dialog) |
| Synchronous branch control for several repositories | Branches popup with several repositories | E |
| Checkout Tag or Revision, New Tag, Reset HEAD (soft / mixed / hard / keep) | Commands, dialogs | I |
| Merge… and Rebase… dialogs with all options | Commands | I |
| Interactive rebase dialog (pick / edit / reword / squash / fixup / drop, reorder) | Dialog | I, V, S 09 |
| Continue / Abort / Skip | Status bar, Commit view banner, VCS popup | I, S 13 |
| Update Project (merge / rebase / branch default, submodules) | ⌘T | I (fetch, merge, rebase) |
| Pull dialog, Fetch, auto fetch | Commands | I |
| Push dialog (target editing, new branch, tags, hooks, force with lease, protected branches, rejected-push update) | ⇧⌘K | I, V (push, new branch), S 08 |
| Manage Remotes, Clone (URL or GitHub list), Create Git Repository, Worktrees | Commands | I |
| Commit File / Rollback on files and folders from the explorer and editor | Explorer / editor → Git | E, W |
| Credentials: HTTPS username / password, SSH passphrase | VS Code input boxes via askpass | I |
| Annotate with Git Blame (age / author colors, name format, annotate previous revision) | Editor gutter | E, S 06 |
| Show History (file, folder), History for Selection, Show Current Revision, Compare with Revision / Branch | Editor / explorer → Git | I |
| VCS Operations popup (⌥\`) | Command | V, S 05 |

## GitHub / GitLab

| JetBrains | Changeline | Evidence |
| --- | --- | --- |
| Pull / merge request list and details (description, reviewers, checks, timeline, commits, files) | Panel *Pull Requests* | M, L, E, V, S 10, H |
| Checkout, merge (merge / squash / rebase), close / reopen | PR details | M |
| Review: approve, request changes, comment | PR details | M, V (comment, approve) |
| Review comments in the diff, line comments and replies | Diff viewer of PR files | M, E, H |
| Create pull request | Command, PR toolbar | M |
| Share Project on GitHub, Create Gist, Sync Fork, Open in Browser | Commands | M |
| GitHub Enterprise, self-managed GitLab | Settings `changeline.github.enterpriseHosts`, `changeline.gitlab.hosts` | M |

## Platforms

- **macOS:** all suites pass: 50 unit and integration tests (including the two checks against the real GitHub and GitLab APIs and the completeness check of the German translation), 18 end-to-end tests through commands, 14 end-to-end tests in the real UI, 2 end-to-end tests with the German display language, and the screenshot run. The end-to-end tests run with an isolated Git configuration (`GIT_CONFIG_GLOBAL`), so the machine's settings cannot change the results.
- **Linux (Docker, git 2.39):** 42 unit and integration tests and 31 end-to-end tests passed inside VS Code under Xvfb (2026-10-21). The activity bar badge test, the German translation and its tests (added on 2026-10-26) have run on macOS only.
- **Windows:** deliberately not run on a real Windows machine (decision of the project owner, 2026-10-21). The path logic (drive letter case, backslashes against git's forward slashes, UNC paths, named pipe for askpass, script paths for Git for Windows' `sh`) is unit-tested with `path.win32` on every platform, and `.github/workflows/ci.yml` runs every suite on Windows, macOS and Linux if the project is pushed to GitHub.
