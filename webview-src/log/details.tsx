import { useEffect, useState } from 'preact/hooks';
import { FileTree, IconButton, useSplitter } from '../common/components';
import { fullDate } from '../common/format';
import { call, getState, patchState } from '../common/rpc';
import type { Details } from './types';
import { plural, t, tx } from '../common/l10n';

export function DetailsPane(props: { details?: Details; loading: boolean; logId: string; highlightPath?: string; parentIndex: number; onParentChange: (index: number) => void; onNavigate: (hash: string) => void }) {
	const [groupByDir, setGroupByDir] = useState<boolean>(getState<{ detailsGroup: boolean }>().detailsGroup ?? true);
	const [selected, setSelected] = useState<string[]>([]);
	const [containing, setContaining] = useState<{ branches: string[]; tags: string[] } | 'loading' | undefined>(undefined);
	const [messageHeight, onSplit] = useSplitter('details-message', 140, { vertical: true, invert: true, min: 40 });
	const d = props.details;
	const single = d && d.commits.length === 1 ? d.commits[0] : undefined;

	useEffect(() => {
		setContaining(undefined);
		setSelected(props.highlightPath ? [props.highlightPath] : []);
	}, [d]);

	if (!d) {
		return <div class="details-pane"><div class="jg-empty">{props.loading ? t('Loading…') : t('Select a commit to view changes')}</div></div>;
	}
	const hashes = d.commits.map((c) => c.hash);
	return (
		<div class="details-pane">
			<div class="jg-toolbar">
				<span class="details-title">{single ? plural(d.files.length, '{0} file changed', '{0} files changed') : `${plural(d.commits.length, '{0} commit selected', '{0} commits selected')} · ${plural(d.files.length, '{0} file', '{0} files')}`}</span>
				<span class="spacer" />
				{single && single.parents.length > 1 && (
					<select class="parent-select" value={props.parentIndex} title={t('Merge commit: show changes relative to')} onChange={(e) => props.onParentChange(Number((e.target as HTMLSelectElement).value))}>
						{single.parents.map((p, i) => (
							<option value={i}>
								{t('Changes to parent {0} ({1})', i + 1, p.slice(0, 8))}
							</option>
						))}
					</select>
				)}
				<IconButton
					icon="list-tree"
					title={t('Group by Directory')}
					active={groupByDir}
					onClick={() => {
						setGroupByDir(!groupByDir);
						patchState({ detailsGroup: !groupByDir });
					}}
				/>
			</div>
			<div class="jg-scroll details-files">
				<FileTree
					files={d.files}
					groupByDir={groupByDir}
					selected={selected}
					highlight={props.highlightPath}
					onSelect={setSelected}
					onOpen={(f) => call('openDiff', { hashes, path: f.path, files: d.files, parentIndex: props.parentIndex })}
					context={(f) => ({ webviewSection: 'logFile', logId: props.logId, path: f.path, origPath: f.origPath, status: f.status, hash: d.commits[0].hash, multiple: d.commits.length > 1 })}
					emptyText={t('No changes')}
				/>
			</div>
			<div class="jg-splitter-h" onMouseDown={onSplit as any} />
			<div class="jg-scroll details-message" style={{ height: `${messageHeight}px` }}>
				{single ? (
					<div class="commit-info">
						<div class="subject">{single.subject}</div>
						{single.body.split('\n').slice(1).join('\n').trim() && <pre class="body">{single.body.split('\n').slice(1).join('\n').trim()}</pre>}
						<div class="meta">
							<span class="hash" title={t('Click to copy')} onClick={() => call('command', { command: 'changeline.copyText', args: [single.hash] })}>
								{single.hash.slice(0, 8)}
							</span>{' '}
							{tx('{0} {1} on {2}', <span class="author">{single.author}</span>, <span class="jg-muted">&lt;{single.authorEmail}&gt;</span>, fullDate(single.authorDate))}
						</div>
						{(single.committer !== single.author || single.commitDate !== single.authorDate) && (
							<div class="meta jg-muted">
								{t('committed by {0} on {1}', single.committer, fullDate(single.commitDate))}
							</div>
						)}
						{single.parents.length > 0 && (
							<div class="meta jg-muted">
								{single.parents.length > 1 ? t('Parents:') : t('Parent:')}{' '}
								{single.parents.map((p) => (
									<a class="jg-link mono" onClick={() => props.onNavigate(p)}>
										{p.slice(0, 8)}{' '}
									</a>
								))}
							</div>
						)}
						<div class="meta">
							{containing === undefined ? (
								<a
									class="jg-link"
									onClick={async () => {
										setContaining('loading');
										setContaining(await call<{ branches: string[]; tags: string[] }>('containing', { hash: single.hash }));
									}}
								>
									{t('Show branches containing this commit')}
								</a>
							) : containing === 'loading' ? (
								<span class="jg-muted">{t('Looking for branches…')}</span>
							) : (
								<span class="jg-muted">
									{containing.branches.length === 1 ? t('In {0} branch: {1}', 1, containing.branches[0]) : t('In {0} branches: {1}', containing.branches.length, containing.branches.join(', ') || '–')}
									{containing.tags.length > 0 && ' · ' + t('Tags: {0}', containing.tags.join(', '))}
								</span>
							)}
						</div>
					</div>
				) : (
					<div class="commit-info">
						{d.commits.map((c) => (
							<div class="multi-row">
								<a class="jg-link mono" onClick={() => props.onNavigate(c.hash)}>
									{c.hash.slice(0, 8)}
								</a>{' '}
								{c.subject} <span class="jg-muted">— {c.author}</span>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
