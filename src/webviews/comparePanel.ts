import * as vscode from 'vscode';
import { commitFileTarget, openDiff, revisionTarget } from '../diff';
import type { Repository } from '../git/repository';
import { services } from '../services';
import type { CommitInfo, FileChange } from '../shared/types';
import { RpcHandlers, WebviewPanelBase } from './host';

export interface CompareRequest {
	repo: Repository;
	title: string;
	left: string;
	right?: string;
	leftLabel: string;
	rightLabel: string;
	swappable?: boolean;
	withCommits?: boolean;
	paths?: string[];
}

async function load(req: CompareRequest) {
	const files = await req.repo.diffFiles(req.left, req.right, req.paths);
	let sections: { title: string; commits: CommitInfo[] }[] = [];
	if (req.withCommits && req.right) {
		const [a, b] = await Promise.all([
			req.repo.log({ revisions: [`${req.left}..${req.right}`], limit: 2000, order: 'topo' }),
			req.repo.log({ revisions: [`${req.right}..${req.left}`], limit: 2000, order: 'topo' }),
		]);
		sections = [
			{ title: vscode.l10n.t('Commits in {0} that are not in {1}', req.rightLabel, req.leftLabel), commits: a },
			{ title: vscode.l10n.t('Commits in {0} that are not in {1}', req.leftLabel, req.rightLabel), commits: b },
		];
	}
	return { title: req.title, leftLabel: req.leftLabel, rightLabel: req.rightLabel, files, sections, swappable: !!req.swappable };
}

export class ComparePanel extends WebviewPanelBase {
	static async show(req: CompareRequest): Promise<void> {
		new ComparePanel(req);
	}

	private constructor(private req: CompareRequest) {
		super(services().context.extensionUri, 'changeline.compare', req.title, 'compare', null, vscode.ViewColumn.Active);
	}

	protected handlers(): RpcHandlers {
		return {
			ready: () => load(this.req),
			swap: async () => {
				if (!this.req.right) {
					return load(this.req);
				}
				this.req = { ...this.req, left: this.req.right, right: this.req.left, leftLabel: this.req.rightLabel, rightLabel: this.req.leftLabel, title: vscode.l10n.t('Compare {0} with {1}', this.req.rightLabel, this.req.leftLabel) };
				this.panel.title = this.req.title;
				return load(this.req);
			},
			commitFiles: async (p: { hash: string }) => {
				const c = await this.req.repo.getCommit(p.hash);
				return this.req.repo.getCommitFiles(c.hash, c.parents);
			},
			openCommitDiff: async (p: { hash: string; path: string; files: FileChange[] }) => {
				const c = await this.req.repo.getCommit(p.hash);
				await openDiff({ targets: p.files.map((f) => commitFileTarget(this.req.repo, c, f)), index: Math.max(0, p.files.findIndex((f) => f.path === p.path)) });
			},
			openDiff: async (p: { path: string; files: FileChange[] }) => {
				const targets = p.files.map((f) => {
					const t = revisionTarget(this.req.repo, this.req.left, this.req.right, f);
					return { ...t, leftTitle: this.req.leftLabel, rightTitle: this.req.rightLabel };
				});
				await openDiff({ targets, index: Math.max(0, p.files.findIndex((f) => f.path === p.path)) });
			},
			showInLog: async (p: { hash: string }) => vscode.commands.executeCommand('changeline.showLog', { repo: this.req.repo.root, hash: p.hash }),
			refresh: () => load(this.req),
		};
	}
}
