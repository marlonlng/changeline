import * as vscode from 'vscode';
import { services } from '../services';
import { showDialog } from '../webviews/dialogPanel';

/** Asks for a changelist like JetBrains' Move to Another Changelist; "New Changelist..." opens the dialog. Returns the list id. */
export async function pickChangelist(title: string, current?: string): Promise<string | undefined> {
	const cl = services().changelists;
	const items: (vscode.QuickPickItem & { id?: string })[] = [
		...cl.all.map((l) => ({ label: l.name, description: l.id === current ? vscode.l10n.t('current') : l.id === cl.active.id ? vscode.l10n.t('active') : undefined, id: l.id })),
		{ label: '', kind: vscode.QuickPickItemKind.Separator },
		{ label: vscode.l10n.t('$(add) New Changelist...'), id: '__new' },
	];
	const pick = await vscode.window.showQuickPick(items, { title });
	if (!pick?.id) {
		return undefined;
	}
	return pick.id === '__new' ? newChangelistDialog() : pick.id;
}

/** Moves one chunk of a file to a changelist the user picks. */
export async function moveChunkToChangelist(absPath: string, key: string): Promise<void> {
	const cl = services().changelists;
	const id = await pickChangelist(vscode.l10n.t('Move Change to Another Changelist'), cl.chunkListOf(absPath, key));
	if (id) {
		cl.moveChunk(absPath, key, id);
	}
}

export async function newChangelistDialog(): Promise<string | undefined> {
	const cl = services().changelists;
	const result = await showDialog(
		{
			title: vscode.l10n.t('New Changelist'),
			fields: [
				{ id: 'name', type: 'text', label: vscode.l10n.t('Name:'), required: true, focus: true },
				{ id: 'comment', type: 'textarea', label: vscode.l10n.t('Comment:'), rows: 4 },
				{ id: 'active', type: 'checkbox', label: vscode.l10n.t('Set active'), value: false },
			],
			okLabel: 'OK',
			width: 520,
			liveValidation: true,
		},
		(v) => (cl.findByName(String(v.name ?? '').trim()) ? { name: vscode.l10n.t('A changelist with this name already exists') } : {}),
	);
	if (!result) {
		return undefined;
	}
	return cl.create(String(result.values.name).trim(), String(result.values.comment ?? '').trim() || undefined, result.values.active === true).id;
}
