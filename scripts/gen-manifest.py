import json, collections

pkg = json.load(open('package.json'))
O = collections.OrderedDict

commands = []
def cmd(id, title, icon=None, category='Changeline', enablement=None):
    c = O(command=id, title=title, category=category)
    if icon: c['icon'] = f'$({icon})'
    if enablement: c['enablement'] = enablement
    commands.append(c)

cmd('changeline.vcsOperations', 'VCS Operations Popup...', 'source-control')
cmd('changeline.branches', 'Branches...', 'git-branch')
cmd('changeline.commit', 'Commit...', 'check')
cmd('changeline.commitFile', 'Commit File...', 'check')
cmd('changeline.push', 'Push...', 'arrow-up')
cmd('changeline.pull', 'Pull...', 'arrow-down')
cmd('changeline.fetch', 'Fetch', 'repo-fetch')
cmd('changeline.updateProject', 'Update Project...', 'arrow-down')
cmd('changeline.showLog', 'Show Git Log', 'history')
cmd('changeline.showConsole', 'Show Git Console', 'output')
cmd('changeline.newBranch', 'New Branch...', 'add')
cmd('changeline.checkoutRevision', 'Checkout Tag or Revision...', 'tag')
cmd('changeline.newTag', 'New Tag...', 'tag')
cmd('changeline.merge', 'Merge...', 'git-merge')
cmd('changeline.rebase', 'Rebase...', 'git-pull-request')
cmd('changeline.interactiveRebase', 'Interactive Rebase...')
cmd('changeline.resetHead', 'Reset HEAD...', 'discard')
cmd('changeline.renameBranch', 'Rename Branch...')
cmd('changeline.deleteBranch', 'Delete Branch...')
cmd('changeline.stashChanges', 'Stash Changes...', 'archive')
cmd('changeline.unstashChanges', 'Unstash Changes...', 'archive')
cmd('changeline.shelveChanges', 'Shelve Changes...', 'inbox')
cmd('changeline.resolveConflicts', 'Resolve Conflicts...', 'warning')
cmd('changeline.continueOperation', 'Continue Rebase / Merge / Cherry-Pick', 'debug-continue')
cmd('changeline.abortOperation', 'Abort Rebase / Merge / Cherry-Pick', 'debug-stop')
cmd('changeline.skipCommit', 'Skip Commit (Rebase / Cherry-Pick)', 'debug-step-over')
cmd('changeline.manageRemotes', 'Manage Remotes...', 'cloud')
cmd('changeline.worktrees', 'Manage Worktrees...', 'repo-forked')
cmd('changeline.pullRequests.create', 'Create Pull Request...', 'git-pull-request-create')
cmd('changeline.pullRequests.show', 'View Pull Requests', 'git-pull-request')
cmd('changeline.pullRequests.refresh', 'Refresh Pull Requests', 'refresh')
cmd('changeline.hosting.signOut', 'Forget GitLab / GitHub Enterprise Token')
cmd('changeline.github.share', 'Share Project on GitHub...', 'github')
cmd('changeline.github.createGist', 'Create Gist...', 'github')
cmd('changeline.github.syncFork', 'Sync Fork', 'repo-forked')
cmd('changeline.compareWithClipboard', 'Compare with Clipboard', 'clippy')
cmd('changeline.showLogInNewTab', 'Show Git Log in New Tab', 'add')
cmd('changeline.testGit', 'Test Git Executable')
cmd('changeline.clone', 'Clone...', 'repo-clone')
cmd('changeline.init', 'Create Git Repository...', 'repo')
cmd('changeline.applyPatch', 'Apply Patch...', 'file-add')
cmd('changeline.refresh', 'Refresh Repositories', 'refresh')
cmd('changeline.annotate', 'Annotate with Git Blame', 'person')
cmd('changeline.annotate.close', 'Close Annotations', 'close')
cmd('changeline.showDiff', 'Show Diff', 'diff')
cmd('changeline.compareWithRevision', 'Compare with Revision...', 'git-compare')
cmd('changeline.compareWithBranch', 'Compare with Branch...', 'git-compare')
cmd('changeline.showHistory', 'Show History', 'history')
cmd('changeline.showHistoryForSelection', 'Show History for Selection', 'history')
cmd('changeline.showCurrentRevision', 'Show Current Revision')
cmd('changeline.rollbackFile', 'Rollback...', 'discard')
cmd('changeline.addFile', 'Add', 'add')
cmd('changeline.addToGitignore', 'Add to .gitignore')
cmd('changeline.openInBrowser', 'Open in Browser (GitHub / GitLab / Bitbucket)', 'link-external')
cmd('changeline.commitMessageHistory', 'Show Commit Message History', 'history')

cmd('changeline.changes.open', 'Show Diff')
cmd('changeline.changes.showDiff', 'Show Diff', 'diff')
cmd('changeline.changes.showNativeDiff', 'Show Diff in VS Code Diff Editor', 'split-horizontal')
cmd('changeline.changes.openFile', 'Jump to Source', 'go-to-file')
cmd('changeline.changes.refresh', 'Refresh', 'refresh')
cmd('changeline.changes.rollback', 'Rollback...', 'discard')
cmd('changeline.changes.moveToChangelist', 'Move to Another Changelist...', 'move')
cmd('changeline.changes.newChangelist', 'New Changelist...', 'new-folder')
cmd('changeline.changes.setActive', 'Set Active Changelist', 'pass-filled')
cmd('changeline.changes.editChangelist', 'Edit Changelist...', 'edit')
cmd('changeline.changes.deleteChangelist', 'Delete Changelist', 'trash')
cmd('changeline.changes.shelve', 'Shelve Changes...', 'inbox')
cmd('changeline.changes.shelveSilently', 'Shelve Silently', 'inbox')
cmd('changeline.changes.addToVcs', 'Add to VCS', 'add')
cmd('changeline.changes.ignore', 'Add to .gitignore...', 'eye-closed')
cmd('changeline.changes.delete', 'Delete...', 'trash')
cmd('changeline.changes.stage', 'Stage', 'add')
cmd('changeline.changes.unstage', 'Unstage', 'remove')
cmd('changeline.changes.stageAll', 'Stage All', 'add')
cmd('changeline.changes.unstageAll', 'Unstage All', 'remove')
cmd('changeline.changes.includeAll', 'Include All into Commit', 'check-all')
cmd('changeline.changes.excludeAll', 'Exclude All from Commit', 'close-all')
cmd('changeline.changes.commitSelected', 'Commit Selected Files...', 'check')
cmd('changeline.changes.showHistory', 'Show History', 'history')
cmd('changeline.changes.createPatch', 'Create Patch...', 'file-diff')
cmd('changeline.changes.groupByDirectory', 'Group by Directory', 'list-tree')
cmd('changeline.changes.groupByNone', 'Flat List (No Grouping)', 'list-flat')
cmd('changeline.changes.expandAll', 'Expand All', 'expand-all')
cmd('changeline.changes.toggleStagingArea', 'Toggle Staging Area / Changelists', 'layers')
cmd('changeline.changes.toggleIgnored', 'Show / Hide Ignored Files', 'eye')

cmd('changeline.shelf.refresh', 'Refresh', 'refresh')
cmd('changeline.shelf.unshelve', 'Unshelve...', 'arrow-circle-up')
cmd('changeline.shelf.unshelveSilently', 'Unshelve Silently', 'arrow-circle-up')
cmd('changeline.shelf.delete', 'Delete', 'trash')
cmd('changeline.shelf.restore', 'Restore', 'history')
cmd('changeline.shelf.rename', 'Rename...', 'edit')
cmd('changeline.shelf.emptyDeleted', 'Empty Recently Deleted', 'clear-all')
cmd('changeline.shelf.createPatch', 'Create Patch...', 'file-diff')
cmd('changeline.shelf.importPatch', 'Import Patches...', 'file-add')
cmd('changeline.shelf.showDiff', 'Show Diff', 'diff')
cmd('changeline.stash.refresh', 'Refresh', 'refresh')
cmd('changeline.stash.apply', 'Apply', 'check')
cmd('changeline.stash.pop', 'Pop', 'arrow-circle-up')
cmd('changeline.stash.applyIndex', 'Apply and Reinstate Index')
cmd('changeline.stash.drop', 'Drop', 'trash')
cmd('changeline.stash.clear', 'Clear All Stashes', 'clear-all')
cmd('changeline.stash.branch', 'Unstash as Branch...', 'git-branch')
cmd('changeline.stash.showDiff', 'Show Diff', 'diff')

log_cmds = [
    ('copyRevision', 'Copy Revision Number', 'copy'),
    ('createPatch', 'Create Patch...', 'file-diff'),
    ('cherryPick', 'Cherry-Pick', 'git-pull-request-go-to-changes'),
    ('checkoutRevision', 'Checkout Revision', 'check'),
    ('showRepositoryAtRevision', 'Show Repository at Revision', 'repo'),
    ('compareWithLocal', 'Compare with Local', 'git-compare'),
    ('showDiff', 'Show Diff', 'diff'),
    ('resetToHere', 'Reset Current Branch to Here...', 'discard'),
    ('revertCommit', 'Revert Commit', 'reply'),
    ('undoCommit', 'Undo Commit...', 'debug-step-back'),
    ('editMessage', 'Edit Commit Message...', 'edit'),
    ('fixup', 'Fixup...', 'fold'),
    ('squashInto', 'Squash Into...', 'fold-down'),
    ('squashCommits', 'Squash Commits...', 'fold-down'),
    ('dropCommits', 'Drop Commits', 'trash'),
    ('interactiveRebase', 'Interactively Rebase from Here...', 'git-pull-request'),
    ('pushUpToHere', 'Push All up to Here...', 'arrow-up'),
    ('newBranch', 'New Branch...', 'git-branch'),
    ('newTag', 'New Tag...', 'tag'),
    ('goToParent', 'Go to Parent Commit', 'arrow-down'),
    ('goToChild', 'Go to Child Commit', 'arrow-up'),
    ('goTo', 'Go to Hash / Branch / Tag...', 'search'),
    ('openInBrowser', 'Open in Browser', 'link-external'),
    ('refresh', 'Refresh', 'refresh'),
]
for id, t, i in log_cmds:
    cmd(f'changeline.log.{id}', t, i, category='Changeline Log')
logfile_cmds = [
    ('showDiff', 'Show Diff', 'diff'),
    ('compareWithLocal', 'Compare with Local', 'git-compare'),
    ('openRepositoryVersion', 'Open Repository Version', 'file'),
    ('editSource', 'Edit Source', 'go-to-file'),
    ('revertSelectedChanges', 'Revert Selected Changes', 'discard'),
    ('cherryPickSelectedChanges', 'Cherry-Pick Selected Changes', 'git-pull-request-go-to-changes'),
    ('historyUpToHere', 'Show History up to Here', 'history'),
    ('getRevision', 'Get (Replace Local File with This Revision)', 'cloud-download'),
    ('annotate', 'Annotate Revision', 'person'),
    ('openInBrowser', 'Open in Browser', 'link-external'),
]
for id, t, i in logfile_cmds:
    cmd(f'changeline.logFile.{id}', t, i, category='Changeline Log')
logbranch_cmds = [
    ('checkout', 'Checkout'),
    ('newFrom', 'New Branch from Selected...'),
    ('checkoutRebase', 'Checkout and Rebase onto Current'),
    ('compare', 'Compare with Current'),
    ('diffWorking', 'Show Diff with Working Tree'),
    ('rebaseOnto', 'Rebase Current onto Selected'),
    ('merge', 'Merge into Current'),
    ('pullRebase', 'Pull into Current Using Rebase'),
    ('pullMerge', 'Pull into Current Using Merge'),
    ('update', 'Update'),
    ('push', 'Push...'),
    ('rename', 'Rename...'),
    ('tracking', 'Edit Tracking...'),
    ('pushTag', 'Push Tag'),
    ('favorite', 'Add to / Remove from Favorites'),
    ('newLogTab', 'Show in New Log Tab'),
    ('delete', 'Delete'),
]
for id, t in logbranch_cmds:
    cmd(f'changeline.logBranch.{id}', t, category='Changeline Branch')
cmd('changeline.copyText', 'Copy')
cmd('changeline.openRevisionFile', 'Open Local File')
cmd('changeline.annotate.showDiff', 'Show Diff of Annotated Commit')
cmd('changeline.annotate.previous', 'Annotate Previous Revision')

hidden_prefix = ('changeline.changes.', 'changeline.shelf.', 'changeline.stash.', 'changeline.log.', 'changeline.logFile.', 'changeline.logBranch.')
palette_visible = {'changeline.changes.refresh', 'changeline.changes.newChangelist', 'changeline.changes.toggleStagingArea', 'changeline.changes.toggleIgnored', 'changeline.changes.rollback', 'changeline.changes.createPatch', 'changeline.changes.groupByDirectory', 'changeline.changes.groupByNone', 'changeline.changes.includeAll', 'changeline.changes.excludeAll', 'changeline.shelf.importPatch', 'changeline.stash.clear'}
always_hidden = {'changeline.changes.open', 'changeline.copyText', 'changeline.openRevisionFile', 'changeline.annotate.showDiff', 'changeline.annotate.previous'}
palette = []
for c in commands:
    id = c['command']
    if id in always_hidden or (id.startswith(hidden_prefix) and id not in palette_visible):
        palette.append(O(command=id, when='false'))
for id in ['changeline.continueOperation', 'changeline.abortOperation', 'changeline.skipCommit']:
    palette.append(O(command=id, when='changeline.hasRepository'))
palette.append(O(command='changeline.annotate.close', when='changeline.annotateActive'))

CH = "view == changeline.changes"
FILE = "viewItem =~ /^changeline:file/"
LOGVIEW = "(webviewId == 'changeline.log' || webviewId == 'changeline.history')"

menus = O()
menus['commandPalette'] = palette
menus['view/title'] = [
    O(command='changeline.changes.refresh', when=CH, group='navigation@1'),
    O(command='changeline.changes.rollback', when=CH, group='navigation@2'),
    O(command='changeline.changes.showDiff', when=CH, group='navigation@3'),
    O(command='changeline.changes.stageAll', when=f'{CH} && changeline.stagingArea', group='navigation@4'),
    O(command='changeline.changes.unstageAll', when=f'{CH} && changeline.stagingArea', group='navigation@5'),
    O(command='changeline.changes.shelve', when=CH, group='navigation@6'),
    O(submenu='changeline.changes.groupBy', when=CH, group='navigation@7'),
    O(command='changeline.changes.expandAll', when=CH, group='navigation@8'),
    O(command='changeline.changes.newChangelist', when=f'{CH} && !changeline.stagingArea', group='1_changelists@1'),
    O(command='changeline.changes.includeAll', when=f'{CH} && !changeline.stagingArea', group='1_changelists@2'),
    O(command='changeline.changes.excludeAll', when=f'{CH} && !changeline.stagingArea', group='1_changelists@3'),
    O(command='changeline.changes.toggleStagingArea', when=CH, group='2_mode@1'),
    O(command='changeline.changes.toggleIgnored', when=CH, group='2_mode@2'),
    O(command='changeline.changes.createPatch', when=CH, group='3_patch@1'),
    O(command='changeline.applyPatch', when=CH, group='3_patch@2'),
    O(command='changeline.resolveConflicts', when=f'{CH} && changeline.hasConflicts', group='navigation@0'),
    O(command='changeline.shelf.importPatch', when='view == changeline.shelf', group='navigation@1'),
    O(command='changeline.shelf.refresh', when='view == changeline.shelf', group='navigation@2'),
    O(command='changeline.shelf.emptyDeleted', when='view == changeline.shelf', group='1_more'),
    O(command='changeline.stashChanges', when='view == changeline.stash', group='navigation@1'),
    O(command='changeline.unstashChanges', when='view == changeline.stash', group='navigation@2'),
    O(command='changeline.stash.refresh', when='view == changeline.stash', group='navigation@3'),
    O(command='changeline.stash.clear', when='view == changeline.stash', group='1_more'),
    O(command='changeline.updateProject', when='view == changeline.log', group='navigation@1'),
    O(command='changeline.push', when='view == changeline.log', group='navigation@2'),
    O(command='changeline.fetch', when='view == changeline.log', group='navigation@3'),
    O(command='changeline.branches', when='view == changeline.log', group='navigation@4'),
    O(command='changeline.showConsole', when='view == changeline.log', group='navigation@5'),
    O(command='changeline.showLogInNewTab', when='view == changeline.log', group='navigation@0'),
    O(command='changeline.pullRequests.create', when='view == changeline.pullRequests', group='navigation@1'),
    O(command='changeline.pullRequests.refresh', when='view == changeline.pullRequests', group='navigation@2'),
    O(command='changeline.hosting.signOut', when='view == changeline.pullRequests', group='1_more'),
]
menus['changeline.changes.groupBy'] = [
    O(command='changeline.changes.groupByDirectory', group='1@1'),
    O(command='changeline.changes.groupByNone', group='1@2'),
]
F_NOT_UNV = f"{FILE} && viewItem =~ /group=(changelist|staged|unstaged|conflicts)/"
menus['view/item/context'] = [
    O(command='changeline.changes.stage', when=f"{CH} && {FILE} && viewItem =~ /group=(unstaged|unversioned)/ && changeline.stagingArea", group='inline@1'),
    O(command='changeline.changes.unstage', when=f"{CH} && {FILE} && viewItem =~ /group=staged/", group='inline@1'),
    O(command='changeline.changes.addToVcs', when=f"{CH} && {FILE} && viewItem =~ /group=unversioned/ && !changeline.stagingArea", group='inline@1'),
    O(command='changeline.changes.openFile', when=f"{CH} && {FILE} && viewItem =~ /status=[^D]/", group='inline@2'),
    O(command='changeline.changes.rollback', when=f"{CH} && {F_NOT_UNV}", group='inline@3'),
    O(command='changeline.changes.commitSelected', when=f"{CH} && viewItem =~ /^changeline:(file|dir|changelist)/", group='1_commit@1'),
    O(command='changeline.changes.rollback', when=f"{CH} && viewItem =~ /^changeline:(file|dir|changelist)/ && viewItem =~ /group=(changelist|staged|unstaged)|^changeline:changelist/", group='1_commit@2'),
    O(command='changeline.changes.moveToChangelist', when=f"{CH} && viewItem =~ /^changeline:(file|dir)/ && viewItem =~ /group=changelist/", group='1_commit@3'),
    O(command='changeline.changes.stage', when=f"{CH} && viewItem =~ /^changeline:(file|dir|group)/ && viewItem =~ /group=(unstaged|unversioned)/", group='1_commit@4'),
    O(command='changeline.changes.unstage', when=f"{CH} && viewItem =~ /^changeline:(file|dir|group)/ && viewItem =~ /group=staged/", group='1_commit@5'),
    O(command='changeline.changes.showDiff', when=f"{CH} && {FILE}", group='2_view@1'),
    O(command='changeline.changes.showNativeDiff', when=f"{CH} && {FILE}", group='2_view@2'),
    O(command='changeline.changes.openFile', when=f"{CH} && {FILE}", group='2_view@3'),
    O(command='changeline.changes.showHistory', when=f"{CH} && {FILE} && viewItem =~ /group=(changelist|staged|unstaged)/", group='2_view@4'),
    O(command='changeline.changes.shelve', when=f"{CH} && viewItem =~ /^changeline:(file|dir|changelist)/", group='3_shelve@1'),
    O(command='changeline.changes.shelveSilently', when=f"{CH} && viewItem =~ /^changeline:(file|dir|changelist)/", group='3_shelve@1b'),
    O(command='changeline.changes.createPatch', when=f"{CH} && viewItem =~ /^changeline:(file|dir|changelist)/", group='3_shelve@2'),
    O(command='changeline.changes.addToVcs', when=f"{CH} && viewItem =~ /group=(unversioned|ignored)/", group='4_vcs@1'),
    O(command='changeline.changes.ignore', when=f"{CH} && viewItem =~ /group=unversioned/", group='4_vcs@2'),
    O(command='changeline.changes.delete', when=f"{CH} && {FILE} && viewItem =~ /status=[^D]/", group='4_vcs@3'),
    O(command='changeline.changes.setActive', when=f"{CH} && viewItem =~ /^changeline:changelist/ && viewItem =~ /removable/ && !(viewItem =~ /;active/)", group='5_cl@1'),
    O(command='changeline.changes.newChangelist', when=f"{CH} && viewItem =~ /^changeline:changelist/", group='5_cl@2'),
    O(command='changeline.changes.editChangelist', when=f"{CH} && viewItem =~ /^changeline:changelist/", group='5_cl@3'),
    O(command='changeline.changes.deleteChangelist', when=f"{CH} && viewItem =~ /^changeline:changelist/ && viewItem =~ /removable/", group='5_cl@4'),
    O(command='changeline.resolveConflicts', when=f"{CH} && viewItem =~ /group=conflicts/", group='1_commit@0'),
    O(command='changeline.shelf.unshelve', when="view == changeline.shelf && viewItem =~ /^changeline:shelf(List|File)$/", group='inline@1'),
    O(command='changeline.shelf.restore', when="view == changeline.shelf && viewItem == 'changeline:shelfList;deleted'", group='inline@1'),
    O(command='changeline.shelf.unshelve', when="view == changeline.shelf && viewItem =~ /^changeline:shelf(List|File)$/", group='1_unshelve@1'),
    O(command='changeline.shelf.unshelveSilently', when="view == changeline.shelf && viewItem =~ /^changeline:shelf(List|File)$/", group='1_unshelve@2'),
    O(command='changeline.shelf.showDiff', when="view == changeline.shelf && viewItem =~ /^changeline:shelfFile/", group='2_view@1'),
    O(command='changeline.shelf.createPatch', when="view == changeline.shelf && viewItem =~ /^changeline:shelfList/", group='2_view@2'),
    O(command='changeline.shelf.rename', when="view == changeline.shelf && viewItem =~ /^changeline:shelfList/", group='3_edit@1'),
    O(command='changeline.shelf.restore', when="view == changeline.shelf && viewItem == 'changeline:shelfList;deleted'", group='3_edit@2'),
    O(command='changeline.shelf.delete', when="view == changeline.shelf && viewItem =~ /^changeline:shelf(List|File)/", group='3_edit@3'),
    O(command='changeline.shelf.emptyDeleted', when="view == changeline.shelf && viewItem == 'changeline:shelfDeleted'", group='3_edit@1'),
    O(command='changeline.stash.pop', when="view == changeline.stash && viewItem == 'changeline:stash'", group='inline@1'),
    O(command='changeline.stash.apply', when="view == changeline.stash && viewItem == 'changeline:stash'", group='1_apply@1'),
    O(command='changeline.stash.pop', when="view == changeline.stash && viewItem == 'changeline:stash'", group='1_apply@2'),
    O(command='changeline.stash.applyIndex', when="view == changeline.stash && viewItem == 'changeline:stash'", group='1_apply@3'),
    O(command='changeline.stash.branch', when="view == changeline.stash && viewItem == 'changeline:stash'", group='1_apply@4'),
    O(command='changeline.stash.drop', when="view == changeline.stash && viewItem == 'changeline:stash'", group='2_drop@1'),
    O(command='changeline.stash.clear', when="view == changeline.stash && viewItem =~ /^changeline:stash(Repo)?$/", group='2_drop@2'),
    O(command='changeline.stash.showDiff', when="view == changeline.stash && viewItem == 'changeline:stashFile'", group='1_apply@1'),
]
C = f"{LOGVIEW} && webviewSection == 'commit'"
menus['webview/context'] = [
    O(command='changeline.log.copyRevision', when=C, group='1_copy@1'),
    O(command='changeline.log.createPatch', when=C, group='1_copy@2'),
    O(command='changeline.log.cherryPick', when=f"{C} && !inHead", group='1_copy@3'),
    O(command='changeline.log.checkoutRevision', when=f"{C} && !multiple", group='2_view@1'),
    O(command='changeline.log.showRepositoryAtRevision', when=f"{C} && !multiple", group='2_view@2'),
    O(command='changeline.log.compareWithLocal', when=f"{C} && !multiple", group='2_view@3'),
    O(command='changeline.log.showDiff', when=f"{C} && !multiple", group='2_view@4'),
    O(command='changeline.log.resetToHere', when=f"{C} && !multiple", group='3_reset@1'),
    O(command='changeline.log.revertCommit', when=C, group='3_reset@2'),
    O(command='changeline.log.undoCommit', when=f"{C} && isHead && !multiple", group='3_reset@3'),
    O(command='changeline.log.editMessage', when=f"{C} && inHead && !multiple", group='4_rewrite@1'),
    O(command='changeline.log.fixup', when=f"{C} && inHead && !multiple", group='4_rewrite@2'),
    O(command='changeline.log.squashInto', when=f"{C} && inHead && !multiple", group='4_rewrite@3'),
    O(command='changeline.log.squashCommits', when=f"{C} && inHead && multiple", group='4_rewrite@4'),
    O(command='changeline.log.dropCommits', when=f"{C} && inHead", group='4_rewrite@5'),
    O(command='changeline.log.interactiveRebase', when=f"{C} && inHead && !multiple", group='4_rewrite@6'),
    O(command='changeline.log.pushUpToHere', when=f"{C} && inHead && !multiple", group='5_push@1'),
    O(command='changeline.log.newBranch', when=f"{C} && !multiple", group='6_refs@1'),
    O(command='changeline.log.newTag', when=f"{C} && !multiple", group='6_refs@2'),
    O(command='changeline.log.goToParent', when=f"{C} && !multiple && !isRoot", group='7_nav@1'),
    O(command='changeline.log.goToChild', when=f"{C} && !multiple", group='7_nav@2'),
    O(command='changeline.log.openInBrowser', when=f"{C} && !multiple", group='8_web@1'),
]
LF = f"{LOGVIEW} && webviewSection == 'logFile'"
menus['webview/context'] += [
    O(command='changeline.logFile.showDiff', when=LF, group='1_diff@1'),
    O(command='changeline.logFile.compareWithLocal', when=f"{LF} && status != 'D'", group='1_diff@2'),
    O(command='changeline.logFile.editSource', when=f"{LF} && status != 'D'", group='2_open@1'),
    O(command='changeline.logFile.openRepositoryVersion', when=LF, group='2_open@2'),
    O(command='changeline.logFile.annotate', when=f"{LF} && status != 'D' && !multiple", group='2_open@3'),
    O(command='changeline.logFile.revertSelectedChanges', when=LF, group='3_apply@1'),
    O(command='changeline.logFile.cherryPickSelectedChanges', when=LF, group='3_apply@2'),
    O(command='changeline.logFile.historyUpToHere', when=f"{LF} && !multiple", group='4_history@1'),
    O(command='changeline.logFile.getRevision', when=f"{LF} && status != 'D' && !multiple", group='3_apply@0'),
    O(command='changeline.logFile.openInBrowser', when=f"{LF} && status != 'D' && !multiple", group='5_web@1'),
]
B = "webviewId == 'changeline.log' && webviewSection == 'branch'"
menus['webview/context'] += [
    O(command='changeline.logBranch.checkout', when=f"{B} && !isCurrent", group='1_checkout@1'),
    O(command='changeline.logBranch.newFrom', when=B, group='1_checkout@2'),
    O(command='changeline.logBranch.checkoutRebase', when=f"{B} && !isCurrent && !isTag", group='1_checkout@3'),
    O(command='changeline.logBranch.compare', when=f"{B} && !isCurrent", group='2_compare@1'),
    O(command='changeline.logBranch.diffWorking', when=f"{B} && !isCurrent", group='2_compare@2'),
    O(command='changeline.logBranch.rebaseOnto', when=f"{B} && !isCurrent", group='3_merge@1'),
    O(command='changeline.logBranch.merge', when=f"{B} && !isCurrent", group='3_merge@2'),
    O(command='changeline.logBranch.pullRebase', when=f"{B} && isRemote", group='3_merge@3'),
    O(command='changeline.logBranch.pullMerge', when=f"{B} && isRemote", group='3_merge@4'),
    O(command='changeline.logBranch.update', when=f"{B} && (isLocal && hasUpstream || ref == 'HEAD')", group='4_remote@1'),
    O(command='changeline.logBranch.push', when=f"{B} && (isLocal || ref == 'HEAD')", group='4_remote@2'),
    O(command='changeline.logBranch.pushTag', when=f"{B} && isTag", group='4_remote@3'),
    O(command='changeline.logBranch.rename', when=f"{B} && isLocal", group='5_edit@1'),
    O(command='changeline.logBranch.tracking', when=f"{B} && isLocal", group='5_edit@2'),
    O(command='changeline.logBranch.favorite', when=f"{B} && (isLocal || isRemote)", group='5_edit@3'),
    O(command='changeline.logBranch.newLogTab', when=f"{B} && ref != 'HEAD'", group='2_compare@3'),
    O(command='changeline.logBranch.delete', when=f"{B} && !isCurrent", group='6_delete@1'),
]
GIT_FILE_ITEMS = [
    ('changeline.commitFile', '1_commit@1', None),
    ('changeline.addFile', '1_commit@2', None),
    ('changeline.annotate', '2_view@1', None),
    ('changeline.showDiff', '2_view@2', None),
    ('changeline.compareWithRevision', '2_view@3', None),
    ('changeline.compareWithBranch', '2_view@4', None),
    ('changeline.compareWithClipboard', '2_view@5', None),
    ('changeline.showHistory', '3_history@1', None),
    ('changeline.showHistoryForSelection', '3_history@2', 'editorHasSelection'),
    ('changeline.showCurrentRevision', '3_history@3', None),
    ('changeline.rollbackFile', '4_rollback@1', None),
    ('changeline.addToGitignore', '4_rollback@2', None),
    ('changeline.openInBrowser', '5_web@1', None),
    ('changeline.github.createGist', '5_web@2', None),
    ('changeline.pullRequests.create', '5_web@3', None),
    ('changeline.branches', '6_repo@1', None),
    ('changeline.push', '6_repo@2', None),
    ('changeline.updateProject', '6_repo@3', None),
    ('changeline.stashChanges', '7_stash@1', None),
    ('changeline.unstashChanges', '7_stash@2', None),
]
menus['changeline.editorGit'] = [O(command=c, group=g, **({'when': w} if w else {})) for c, g, w in GIT_FILE_ITEMS]
menus['changeline.explorerGit'] = [O(command=c, group=g) for c, g, w in GIT_FILE_ITEMS if c not in ('changeline.showHistoryForSelection',)]
menus['editor/context'] = [O(submenu='changeline.editorGit', when='changeline.hasRepository && resourceScheme == file', group='z_changeline@1')]
menus['explorer/context'] = [O(submenu='changeline.explorerGit', when='changeline.hasRepository', group='7_modification@9')]
menus['editor/title/context'] = [O(submenu='changeline.editorGit', when='changeline.hasRepository && resourceScheme == file', group='z_changeline@1')]
menus['editor/lineNumber/context'] = [
    O(command='changeline.annotate', when='changeline.hasRepository && !changeline.annotateActive', group='navigation'),
    O(command='changeline.annotate.close', when='changeline.annotateActive', group='navigation'),
]
menus['editor/title'] = [
    O(command='changeline.annotate.close', when='changeline.annotateActive', group='navigation@99'),
]

submenus = [
    O(id='changeline.editorGit', label='Git'),
    O(id='changeline.explorerGit', label='Git'),
    O(id='changeline.changes.groupBy', label='Group By', icon='$(list-tree)'),
]

JB = 'config.changeline.jetbrainsKeymap'
keybindings = [
    O(command='changeline.vcsOperations', key='alt+`', when='!terminalFocus'),
    O(command='changeline.vcsOperations', key='alt+`', mac='ctrl+v', when=f'{JB} && !terminalFocus'),
    O(command='changeline.changes.showDiff', key='ctrl+d', mac='cmd+d', when='focusedView == changeline.changes'),
    O(command='changeline.changes.openFile', key='f4', when='focusedView == changeline.changes'),
    O(command='changeline.changes.rollback', key='ctrl+alt+z', mac='cmd+alt+z', when='focusedView == changeline.changes'),
    O(command='changeline.changes.moveToChangelist', key='f6', when='focusedView == changeline.changes'),
    O(command='changeline.changes.delete', key='delete', mac='cmd+backspace', when='focusedView == changeline.changes'),
    O(command='changeline.changes.refresh', key='ctrl+r', mac='cmd+r', when='focusedView == changeline.changes'),
    O(command='changeline.commit', key='ctrl+k', mac='cmd+k', when=JB),
    O(command='changeline.push', key='ctrl+shift+k', mac='cmd+shift+k', when=JB),
    O(command='changeline.updateProject', key='ctrl+t', mac='cmd+t', when=JB),
    O(command='changeline.branches', key='ctrl+shift+`', mac='ctrl+shift+`', when=f'{JB} && !terminalFocus'),
    O(command='changeline.changes.rollback', key='ctrl+alt+z', mac='cmd+alt+z', when=f'{JB} && !focusedView'),
    O(command='changeline.showDiff', key='ctrl+d', mac='cmd+d', when=f'{JB} && editorTextFocus && resourceScheme == file'),
    O(command='changeline.log.focus', key='alt+9', mac='cmd+9', when=JB),
    O(command='changeline.changes.focus', key='alt+0', mac='cmd+0', when=JB),
    O(command='changeline.stashChanges', key='', when='false'),
]
keybindings = [k for k in keybindings if k.get('key') != '']

def setting(type_, default, desc, **kw):
    s = O(type=type_, default=default, markdownDescription=desc)
    s.update(kw)
    return s

configuration = O(title='Changeline', properties=O([
    ('changeline.path', setting('string', '', 'Path to the git executable. Empty: use `git.path` or find git automatically.', scope='machine')),
    ('changeline.repositoryScanMaxDepth', setting('number', 1, 'How many folder levels below each workspace folder are scanned for nested repositories.')),
    ('changeline.commit.useStagingArea', setting('boolean', False, 'Use the Git staging area (index) instead of changelists, like *Settings › Version Control › Git › Enable staging area* in JetBrains IDEs.')),
    ('changeline.commit.clickAction', setting('string', 'diff', 'What a click on a file in Local Changes does.', enum=['diff', 'source'], enumDescriptions=['Show the diff', 'Open the file'])),
    ('changeline.commit.subjectLengthLimit', setting('number', 72, 'Warn when the commit subject line is longer than this (0 = off).')),
    ('changeline.commit.bodyLineLengthLimit', setting('number', 72, 'Warn when a commit body line is longer than this (0 = off).')),
    ('changeline.commit.messageInspections', setting('boolean', True, 'Show commit message inspections (subject length, blank line).')),
    ('changeline.commit.signOff', setting('boolean', False, 'Default for "Sign-off commit".')),
    ('changeline.commit.runHooks', setting('boolean', True, 'Default for "Run Git hooks".')),
    ('changeline.commit.analyzeCode', setting('boolean', False, 'Default for "Analyze code" before commit (checks VS Code problems in the committed files).')),
    ('changeline.commit.checkTodo', setting('boolean', False, 'Default for "Check TODO" before commit.')),
    ('changeline.commit.reformatCode', setting('boolean', False, 'Default for "Reformat code" before commit (uses the formatter of the file\'s language).')),
    ('changeline.commit.optimizeImports', setting('boolean', False, 'Default for "Optimize imports" before commit (source.organizeImports).')),
    ('changeline.commit.testTask', setting('string', '', 'VS Code task run by the "Run tests" commit check (task label).')),
    ('changeline.commit.warnAboutCrlf', setting(['boolean', 'null'], None, 'Warn when CRLF line separators are about to be committed and core.autocrlf is not set. Default (null): on for Windows, off elsewhere.')),
    ('changeline.commit.offerDeleteEmptyChangelist', setting('boolean', True, 'Offer to delete a changelist that became empty after a commit.')),
    ('changeline.changes.groupBy', setting('string', 'none', 'Grouping of the Local Changes tree.', enum=['none', 'directory'])),
    ('changeline.changes.groupByRepository', setting('boolean', True, 'Group changes by repository when the workspace has several.')),
    ('changeline.changes.showIgnored', setting('boolean', False, 'Show ignored files in Local Changes.')),
    ('changeline.diff.viewer', setting('string', 'jetbrains', 'Viewer for diffs.', enum=['jetbrains', 'native'], enumDescriptions=['JetBrains style viewer with chunk rollback and partial commit', 'VS Code diff editor'])),
    ('changeline.diff.ignoreWhitespace', setting('string', 'none', 'Default whitespace handling of the diff viewer.', enum=['none', 'trim', 'all'])),
    ('changeline.diff.sideBySide', setting('boolean', True, 'Use the side-by-side viewer by default (otherwise unified).')),
    ('changeline.diff.collapseUnchanged', setting('boolean', False, 'Collapse unchanged fragments by default.')),
    ('changeline.diff.contextLines', setting('number', 4, 'Context lines kept around changes when unchanged fragments are collapsed.')),
    ('changeline.log.pageSize', setting('number', 1000, 'Number of commits loaded at once in the log.')),
    ('changeline.log.order', setting('string', 'date', 'Commit order in the log.', enum=['date', 'topo'], enumDescriptions=['By date (--date-order)', 'Topologically (--topo-order)'])),
    ('changeline.log.dateFormat', setting('string', 'relative', 'Initial date format of the log.', enum=['relative', 'absolute'])),
    ('changeline.annotate.showAuthor', setting('boolean', True, 'Show the author in annotations.')),
    ('changeline.annotate.showDate', setting('boolean', True, 'Show the date in annotations.')),
    ('changeline.annotate.showCommitHash', setting('boolean', False, 'Show the commit hash in annotations.')),
    ('changeline.annotate.colors', setting('string', 'age', 'Background of annotations.', enum=['age', 'author', 'none'])),
    ('changeline.annotate.nameFormat', setting('string', 'full', 'How author names are shown in annotations (JetBrains "Names").', enum=['full', 'first', 'last', 'initials', 'email'])),
    ('changeline.annotate.ignoreWhitespace', setting('boolean', False, 'Ignore whitespace changes when annotating (git blame -w).')),
    ('changeline.update.method', setting('string', 'ask', 'How "Update Project" integrates incoming changes.', enum=['ask', 'merge', 'rebase', 'branchDefault'], enumDescriptions=['Ask with the Update Project dialog', 'Merge', 'Rebase', 'Use the branch configuration (pull.rebase / branch.<name>.rebase)'])),
    ('changeline.update.submodules', setting('boolean', True, 'Update submodules (`git submodule update --init --recursive`) after "Update Project".')),
    ('changeline.branches.syncControl', setting('boolean', True, 'Synchronous branch control: with several repositories, branch operations from the branches popup are executed on all repositories (*Execute branch operations on all roots*).')),
    ('changeline.push.autoUpdateOnReject', setting('string', 'ask', 'What to do when a push is rejected because the remote has new commits.', enum=['ask', 'merge', 'rebase'], enumDescriptions=['Ask', 'Merge the remote changes and push again', 'Rebase onto the remote changes and push again'])),
    ('changeline.push.protectedBranches', setting('array', ['master', 'main'], 'Branches that cannot be force-pushed (wildcards allowed).', items=O(type='string'))),
    ('changeline.cherryPick.addSourceReference', setting('boolean', False, 'Add "(cherry picked from commit ...)" to cherry-picked commits (-x).')),
    ('changeline.shelf.removeAfterUnshelve', setting('boolean', True, 'Remove successfully applied files from the shelf.')),
    ('changeline.autoFetch.interval', setting('number', 0, 'Fetch all remotes every N minutes (0 = off).')),
    ('changeline.statusBar.showBranch', setting('boolean', True, 'Show the current branch in the status bar.')),
    ('changeline.decorations.explorer', setting('boolean', False, 'Color files in the Explorer by their Git status (JetBrains file status colors). Usually the built-in Git extension already does this.')),
    ('changeline.github.enterpriseHosts', setting('array', [], 'Host names of GitHub Enterprise servers (e.g. `git.example.com`) for the Pull Requests tool window.', items=O(type='string'))),
    ('changeline.gitlab.hosts', setting('array', [], 'Host names of self-managed GitLab servers. Hosts containing "gitlab." are detected automatically.', items=O(type='string'))),
    ('changeline.lineStatus.enabled', setting('string', 'auto', 'Gutter markers for changed lines (with VS Code\'s inline diff to roll back a change). `auto` turns them on when the built-in Git support is disabled.', enum=['auto', 'on', 'off'])),
    ('changeline.askpass.enabled', setting('boolean', True, 'Ask for credentials and SSH passphrases in VS Code input boxes.')),
    ('changeline.console.showOutput', setting('boolean', True, 'Write git output of operations to the Changeline Console.')),
    ('changeline.jetbrainsKeymap', setting('boolean', False, 'Enable JetBrains Git shortcuts: ⌘K commit, ⇧⌘K push, ⌘T update project, ⌘D diff, ⌥⌘Z rollback, ⌘9 log, ⌘0 commit tool window (Ctrl on Windows/Linux). **Overrides VS Code shortcuts such as the ⌘K chord.**')),
]))

def color(id, desc, dark, light, hc=None):
    return O(id=id, description=desc, defaults=O(dark=dark, light=light, highContrast=hc or dark, highContrastLight=light))
colors = [
    color('changeline.modifiedForeground', 'Modified files (JetBrains blue).', '#6897BB', '#0032A0'),
    color('changeline.addedForeground', 'Added files.', '#629755', '#067D17'),
    color('changeline.deletedForeground', 'Deleted files.', '#8C8C8C', '#6C6C6C'),
    color('changeline.renamedForeground', 'Renamed / moved files.', '#6897BB', '#0032A0'),
    color('changeline.unversionedForeground', 'Unversioned files.', '#D1675A', '#993300'),
    color('changeline.conflictForeground', 'Files with merge conflicts.', '#D5756C', '#E10000'),
    color('changeline.ignoredForeground', 'Ignored files.', '#848504', '#827717'),
]

contributes = O()
contributes['viewsContainers'] = O(
    activitybar=[O(id='changeline-commit', title='Commit', icon='media/commit.svg')],
    panel=[O(id='changeline-panel', title='Git', icon='media/git.svg'), O(id='changeline-pullrequests', title='Pull Requests', icon='media/pull-request.svg')],
)
contributes['views'] = O([
    ('changeline-commit', [
        O(id='changeline.changes', name='Local Changes', icon='media/commit.svg', contextualTitle='Commit'),
        O(type='webview', id='changeline.commitMessage', name='Commit Message', contextualTitle='Commit', when='changeline.hasRepository'),
        O(id='changeline.shelf', name='Shelf', visibility='collapsed', contextualTitle='Commit'),
        O(id='changeline.stash', name='Stash', visibility='collapsed', contextualTitle='Commit', when='changeline.hasRepository'),
    ]),
    ('changeline-panel', [
        O(type='webview', id='changeline.log', name='Log', contextualTitle='Git'),
    ]),
    ('changeline-pullrequests', [
        O(type='webview', id='changeline.pullRequests', name='Pull Requests', contextualTitle='Pull Requests', when='changeline.hasRepository'),
    ]),
])
contributes['viewsWelcome'] = [
    O(view='changeline.changes', contents='No Git repository found in this workspace.\n[Create Git Repository](command:changeline.init)\n[Clone Repository](command:changeline.clone)', when='!changeline.hasRepository'),
    O(view='changeline.shelf', contents='Shelf is empty. Use "Shelve Changes" in Local Changes to put changes aside.\n[Import Patches](command:changeline.shelf.importPatch)'),
    O(view='changeline.stash', contents='No stashes.\n[Stash Changes](command:changeline.stashChanges)'),
]
nls = O()

def localize(key, text):
    nls[key] = text
    return f'%{key}%'

def short(id):
    return id[len('changeline.'):] if id.startswith('changeline.') else id

for c in commands:
    c['title'] = localize(f"command.{short(c['command'])}", c['title'])
for container in contributes.get('viewsContainers', {}).values():
    for v in container:
        v['title'] = localize(f"viewsContainer.{v['id']}", v['title'])
for views in contributes.get('views', {}).values():
    for v in views:
        v['name'] = localize(f"view.{short(v['id'])}", v['name'])
        if 'contextualTitle' in v:
            v['contextualTitle'] = localize(f"view.{short(v['id'])}.contextualTitle", v['contextualTitle'])
for i, w in enumerate(contributes.get('viewsWelcome', [])):
    w['contents'] = localize(f"viewsWelcome.{short(w['view'])}.{i}", w['contents'])
for s in submenus:
    s['label'] = localize(f"submenu.{short(s['id'])}", s['label'])
for key, prop in configuration['properties'].items():
    for field in ('description', 'markdownDescription'):
        if field in prop:
            prop[field] = localize(f"config.{short(key)}", prop[field])
    if 'enumDescriptions' in prop:
        prop['enumDescriptions'] = [localize(f"config.{short(key)}.{value}", text) for value, text in zip(prop['enum'], prop['enumDescriptions'])]
for color in colors:
    color['description'] = localize(f"color.{short(color['id'])}", color['description'])

contributes['commands'] = commands
contributes['menus'] = menus
contributes['submenus'] = submenus
contributes['keybindings'] = keybindings
contributes['configuration'] = configuration
contributes['colors'] = colors

pkg = O([
    ('name', 'changeline'),
    ('displayName', 'Changeline – Changelists, Shelf & Git Log'),
    ('description', 'Changelists, partial commits, shelf, Git log with graph, branches popup, three-way merge, interactive rebase and pull requests for VS Code: the Git workflow known from JetBrains IDEs. Not affiliated with JetBrains.'),
    ('version', pkg.get('version', '0.1.0')),
    ('publisher', 'marlonlange'),
    ('license', 'MIT'),
    ('repository', O(type='git', url='https://github.com/marlonlng/changeline.git')),
    ('bugs', O(url='https://github.com/marlonlng/changeline/issues')),
    ('homepage', 'https://github.com/marlonlng/changeline#readme'),
    ('icon', 'media/icon.png'),
    ('engines', O(vscode='^1.90.0')),
    ('categories', ['SCM Providers', 'Other']),
    ('keywords', ['git', 'jetbrains', 'phpstorm', 'intellij', 'changelist', 'shelf', 'git log', 'merge', 'rebase', 'blame']),
    ('activationEvents', ['onStartupFinished']),
    ('main', './dist/extension.js'),
    ('l10n', './l10n'),
    ('contributes', contributes),
    ('scripts', O([
        ('build', 'node esbuild.mjs'),
        ('watch', 'node esbuild.mjs --watch'),
        ('package:build', 'node esbuild.mjs --production'),
        ('typecheck', 'tsc -p tsconfig.json --noEmit && tsc -p webview-src/tsconfig.json'),
        ('manifest', 'python3 scripts/gen-manifest.py'),
        ('test:unit', 'tsc -p tsconfig.json && node --test "out/test/unit/*.test.js" "out/test/integration/*.test.js"'),
        ('test:e2e', 'node esbuild.mjs && tsc -p tsconfig.json && node out/test/e2e/runTests.js'),
        ('vscode:prepublish', 'node esbuild.mjs --production'),
        ('package', 'vsce package --no-dependencies'),
    ])),
    ('dependencies', pkg.get('dependencies', {})),
    ('devDependencies', pkg.get('devDependencies', {})),
])
if 'private' in pkg: del pkg['private']
json.dump(pkg, open('package.json', 'w'), indent='\t', ensure_ascii=False)
open('package.json', 'a').write('\n')
json.dump(nls, open('package.nls.json', 'w'), indent='\t', ensure_ascii=False)
open('package.nls.json', 'a').write('\n')
try:
    de = json.load(open('package.nls.de.json'))
except FileNotFoundError:
    de = {}
missing = [k for k in nls if k not in de]
stale = [k for k in de if k not in nls]
if missing or stale:
    print(f'package.nls.de.json: {len(missing)} missing, {len(stale)} stale')
    for k in missing:
        print('  missing', k)
    for k in stale:
        print('  stale', k)
print(len(commands), 'commands')
