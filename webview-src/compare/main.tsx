import '../common/base.css';
import './style.css';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { CommitInfo, FileChange } from '../../src/shared/types';
import { FileTree, Icon, IconButton, useSplitter } from '../common/components';
import { formatDate } from '../common/format';
import { call } from '../common/rpc';
import { plural, t } from '../common/l10n';

interface Data {
	title: string;
	leftLabel: string;
	rightLabel: string;
	files: FileChange[];
	sections: { title: string; commits: CommitInfo[] }[];
	swappable: boolean;
}

function App() {
	const [data, setData] = useState<Data | null>(null);
	const [tab, setTab] = useState<'commits' | 'files'>('commits');
	const [commit, setCommit] = useState<string | null>(null);
	const [commitFiles, setCommitFiles] = useState<FileChange[]>([]);
	const [selFiles, setSelFiles] = useState<string[]>([]);
	const [groupByDir, setGroupByDir] = useState(true);
	const [width, onSplit] = useSplitter('compare', 520, { min: 240 });

	useEffect(() => {
		call<Data>('ready').then((d) => {
			setData(d);
			setTab(d.sections.length ? 'commits' : 'files');
		});
	}, []);

	const pick = async (hash: string) => {
		setCommit(hash);
		setCommitFiles(await call<FileChange[]>('commitFiles', { hash }));
	};

	if (!data) {
		return <div class="jg-empty">{t('Loading…')}</div>;
	}
	return (
		<div class="compare-view">
			<div class="jg-toolbar">
				<span class="title">{data.title}</span>
				{data.swappable && <IconButton icon="arrow-swap" title={t('Swap Branches')} onClick={async () => setData(await call<Data>('swap'))} />}
				<IconButton icon="refresh" title={t('Refresh')} onClick={async () => setData(await call<Data>('refresh'))} />
				<span class="spacer" />
				{data.sections.length > 0 && (
					<div class="tabs">
						<button class={`tab${tab === 'commits' ? ' active' : ''}`} onClick={() => setTab('commits')}>
							{t('Commits')}
						</button>
						<button class={`tab${tab === 'files' ? ' active' : ''}`} onClick={() => setTab('files')}>
							{t('Files ({0})', data.files.length)}
						</button>
					</div>
				)}
				<IconButton icon="list-tree" title={t('Group by Directory')} active={groupByDir} onClick={() => setGroupByDir(!groupByDir)} />
			</div>
			{tab === 'commits' ? (
				<div class="jg-split-h">
					<div class="sections" style={{ width: `${width}px` }}>
						{data.sections.map((s) => (
							<div class="section">
								<div class="section-title">
									{s.title} <span class="jg-badge">{s.commits.length}</span>
								</div>
								{s.commits.length === 0 && <div class="jg-muted none">{t('No commits')}</div>}
								{s.commits.map((c) => (
									<div class={`jg-row${commit === c.hash ? ' selected' : ''}`} onClick={() => pick(c.hash)} onDblClick={() => call('showInLog', { hash: c.hash })} title={c.hash}>
										<Icon name="git-commit" />
										<span class="name">{c.subject}</span>
										<span class="detail">{c.author}</span>
										<span class="detail">{formatDate(c.authorDate, 'relative')}</span>
									</div>
								))}
							</div>
						))}
					</div>
					<div class="jg-splitter-v" onMouseDown={onSplit as any} />
					<div class="jg-scroll files-pane">
						{commit ? (
							<FileTree files={commitFiles} groupByDir={groupByDir} selected={selFiles} onSelect={setSelFiles} onOpen={(f) => call('openCommitDiff', { hash: commit, path: f.path, files: commitFiles })} />
						) : (
							<div class="jg-empty">{t('Select a commit')}</div>
						)}
					</div>
				</div>
			) : (
				<div class="jg-scroll files-only">
					<div class="files-head jg-muted">
						{data.leftLabel} ↔ {data.rightLabel} · {plural(data.files.length, '{0} changed file', '{0} changed files')} · {t('double-click to compare')}
					</div>
					<FileTree files={data.files} groupByDir={groupByDir} selected={selFiles} onSelect={setSelFiles} onOpen={(f) => call('openDiff', { path: f.path, files: data.files })} emptyText={t('No differences')} />
				</div>
			)}
		</div>
	);
}

render(<App />, document.getElementById('app')!);
