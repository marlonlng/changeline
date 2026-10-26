import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Repository } from '../git/repository';
import { services } from '../services';
import type { ConflictInfo } from '../shared/types';
import { basename, plural, samePath, shortHash } from '../util';
import { RpcHandlers, WebviewPanelBase } from './host';

export interface MergeRequest {
	title: string;
	path: string;
	base: string;
	left: string;
	right: string;
	leftTitle: string;
	rightTitle: string;
	apply(result: string): Promise<void>;
}

export class MergePanel extends WebviewPanelBase {
	private static open = new Map<string, MergePanel>();
	private resolveDone!: (applied: boolean) => void;
	readonly done = new Promise<boolean>((r) => (this.resolveDone = r));
	private applied = false;

	static show(req: MergeRequest): Promise<boolean> {
		const existing = MergePanel.open.get(req.path);
		if (existing && !existing.isDisposed) {
			existing.panel.reveal();
			return existing.done;
		}
		const panel = new MergePanel(req);
		MergePanel.open.set(req.path, panel);
		return panel.done;
	}

	private constructor(private readonly req: MergeRequest) {
		super(services().context.extensionUri, 'changeline.merge', vscode.l10n.t('Merge: {0}', path.basename(req.path)), 'merge', null, vscode.ViewColumn.Active);
	}

	protected handlers(): RpcHandlers {
		return {
			ready: () => ({
				title: this.req.title,
				path: this.req.path,
				base: this.req.base,
				left: this.req.left,
				right: this.req.right,
				leftTitle: this.req.leftTitle,
				rightTitle: this.req.rightTitle,
			}),
			apply: async (p: { result: string; unresolved: number }) => {
				if (p.unresolved > 0) {
					const choice = await vscode.window.showWarningMessage(
						plural(p.unresolved, 'There is {0} unresolved change. Save the result and mark the file as resolved anyway?', 'There are {0} unresolved changes. Save the result and mark the file as resolved anyway?'),
						{ modal: true },
						vscode.l10n.t('Apply'),
					);
					if (choice !== vscode.l10n.t('Apply')) {
						return false;
					}
				}
				await this.req.apply(p.result);
				this.applied = true;
				this.dispose();
				return true;
			},
			cancel: async (p: { changed: boolean }) => {
				if (p.changed) {
					const choice = await vscode.window.showWarningMessage(vscode.l10n.t('Discard the changes made in the merge window?'), { modal: true }, vscode.l10n.t('Discard'));
					if (choice !== vscode.l10n.t('Discard')) {
						return false;
					}
				}
				this.dispose();
				return true;
			},
		};
	}

	override dispose(): void {
		if (MergePanel.open.get(this.req.path) === this) {
			MergePanel.open.delete(this.req.path);
		}
		this.resolveDone(this.applied);
		super.dispose();
	}
}

/** Labels for the conflict sides depending on the running operation. */
export async function conflictTitles(repo: Repository): Promise<{ left: string; right: string; title: string }> {
	const st = repo.state;
	const branch = st.branch ?? (st.head ? shortHash(st.head) : 'HEAD');
	switch (st.operation) {
		case 'merge': {
			const msg = await repo.readGitFile('MERGE_MSG');
			const m = msg && /^Merge (?:remote-tracking )?branch(?:es)? '([^']+)'/m.exec(msg);
			const theirs = m ? m[1] : st.mergeHead ? shortHash(st.mergeHead) : 'theirs';
			return { left: vscode.l10n.t('Your version ({0})', branch), right: vscode.l10n.t('Changes from {0}', theirs), title: vscode.l10n.t('Merging {0} into {1}', theirs, branch) };
		}
		case 'rebase': {
			const onto = st.rebase?.onto ? shortHash(st.rebase.onto) : 'upstream';
			const head = st.rebase?.stoppedSha ? shortHash(st.rebase.stoppedSha) : 'commit';
			return { left: vscode.l10n.t('Changes from upstream ({0})', onto), right: vscode.l10n.t('Your changes ({0})', head), title: vscode.l10n.t('Rebasing {0}', st.rebase?.headName?.replace('refs/heads/', '') ?? branch) };
		}
		case 'cherry-pick':
			return { left: vscode.l10n.t('Your version ({0})', branch), right: st.cherryPickHead ? vscode.l10n.t('Changes from {0}', shortHash(st.cherryPickHead)) : vscode.l10n.t('Changes from the commit'), title: vscode.l10n.t('Cherry-picking') };
		case 'revert':
			return { left: vscode.l10n.t('Your version ({0})', branch), right: st.revertHead ? vscode.l10n.t('Revert of {0}', shortHash(st.revertHead)) : vscode.l10n.t('Revert of the commit'), title: vscode.l10n.t('Reverting') };
		default:
			return { left: vscode.l10n.t('Your version ({0})', branch), right: vscode.l10n.t('Changes from stash / patch'), title: vscode.l10n.t('Merging') };
	}
}

export async function openGitConflictMerge(repo: Repository, conflict: ConflictInfo): Promise<boolean> {
	const [base, left, right] = await Promise.all([
		repo.getContentOrEmpty(':1', conflict.path, { filters: true }),
		repo.getContentOrEmpty(':2', conflict.path, { filters: true }),
		repo.getContentOrEmpty(':3', conflict.path, { filters: true }),
	]);
	const titles = await conflictTitles(repo);
	return MergePanel.show({
		title: titles.title,
		path: repo.absolutePath(conflict.path),
		base: base?.toString('utf8') ?? '',
		left: left?.toString('utf8') ?? '',
		right: right?.toString('utf8') ?? '',
		leftTitle: titles.left,
		rightTitle: titles.right,
		apply: async (result) => {
			const abs = repo.absolutePath(conflict.path);
			await fs.promises.mkdir(path.dirname(abs), { recursive: true });
			const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && samePath(d.uri.fsPath, abs));
			if (doc && doc.isDirty) {
				await doc.save();
			}
			await fs.promises.writeFile(abs, result, 'utf8');
			await repo.add([conflict.path]);
		},
	});
}
