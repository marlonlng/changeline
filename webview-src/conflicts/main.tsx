import '../common/base.css';
import './style.css';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Icon } from '../common/components';
import { basename, dirname } from '../common/format';
import { call, on } from '../common/rpc';
import { plural, t } from '../common/l10n';

interface Conflict {
	path: string;
	code: string;
	ours: string;
	theirs: string;
}

interface Group {
	root: string;
	name: string;
	title: string;
	left: string;
	right: string;
	operation: string;
	files: Conflict[];
}

interface Data {
	groups: Group[];
	multiple: boolean;
}

function App() {
	const [data, setData] = useState<Data | null>(null);
	const [selected, setSelected] = useState<{ root: string; paths: string[] }>({ root: '', paths: [] });
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		call<Data>('ready').then(setData);
		return on<Data>('data', setData);
	}, []);

	if (!data) {
		return <div class="jg-empty">{t('Loading…')}</div>;
	}
	const run = async (method: string, params: unknown) => {
		setBusy(true);
		try {
			await call(method, params);
		} finally {
			setBusy(false);
		}
	};
	const sel = selected.paths.length ? selected : data.groups[0] && data.groups[0].files[0] ? { root: data.groups[0].root, paths: [data.groups[0].files[0].path] } : selected;
	const selectedConflict = data.groups.find((g) => g.root === sel.root)?.files.find((f) => f.path === sel.paths[0]);
	const canMerge = sel.paths.length === 1 && selectedConflict && selectedConflict.ours !== 'deleted' && selectedConflict.theirs !== 'deleted';
	const total = data.groups.reduce((n, g) => n + g.files.length, 0);

	return (
		<div class="conflicts">
			<div class="header">
				<h2>{t('Conflicts')}</h2>
				<p class="jg-muted">{total ? plural(total, '{0} file with conflicts. Resolve it to continue.', '{0} files with conflicts. Resolve them to continue.') : t('All conflicts have been resolved.')}</p>
			</div>
			<div class="body">
				<div class="table jg-focus-within" tabIndex={0}>
					{data.groups.map((g) => (
						<div class="group">
							<div class="group-title">
								{data.multiple && <strong>{g.name} · </strong>}
								{g.title}
								<button class="jg-link abort" onClick={() => run('abort', { root: g.root })}>
									{t('Abort {0}', g.operation)}
								</button>
							</div>
							<div class="thead">
								<span>{t('Name')}</span>
								<span title={g.left}>{t('Yours')}</span>
								<span title={g.right}>{t('Theirs')}</span>
							</div>
							{g.files.map((f) => {
								const isSel = sel.root === g.root && sel.paths.includes(f.path);
								return (
									<div
										class={`jg-row trow${isSel ? ' selected' : ''}`}
										onClick={(e) => {
											if ((e.metaKey || e.ctrlKey) && sel.root === g.root) {
												setSelected({ root: g.root, paths: isSel ? sel.paths.filter((p) => p !== f.path) : [...sel.paths, f.path] });
											} else {
												setSelected({ root: g.root, paths: [f.path] });
											}
										}}
										onDblClick={() => (f.ours !== 'deleted' && f.theirs !== 'deleted' ? run('merge', { root: g.root, path: f.path }) : undefined)}
									>
										<span class="name-cell">
											<Icon name="warning" className="st-U" />
											<span class="name st-U">{basename(f.path)}</span>
											<span class="detail">{dirname(f.path)}</span>
										</span>
										<span class={`state ${f.ours}`}>{cap(f.ours)}</span>
										<span class={`state ${f.theirs}`}>{cap(f.theirs)}</span>
									</div>
								);
							})}
						</div>
					))}
				</div>
				<div class="actions">
					<button class="jg-btn" disabled={busy || !sel.paths.length} onClick={() => run('acceptYours', sel)}>
						{t('Accept Yours')}
					</button>
					<button class="jg-btn" disabled={busy || !sel.paths.length} onClick={() => run('acceptTheirs', sel)}>
						{t('Accept Theirs')}
					</button>
					<button class="jg-btn primary" disabled={busy || !canMerge} onClick={() => run('merge', { root: sel.root, path: sel.paths[0] })}>
						{t('Merge...')}
					</button>
					<button class="jg-btn" disabled={!sel.paths.length} onClick={() => run('open', { root: sel.root, path: sel.paths[0] })}>
						{t('Open in Editor')}
					</button>
				</div>
			</div>
			<div class="footer">
				<span class="jg-muted">{t('Double-click a file to open the merge window.')}</span>
				<span class="spacer" />
				<button class="jg-btn" onClick={() => call('close')}>
					{t('Close')}
				</button>
			</div>
		</div>
	);
}

function cap(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

render(<App />, document.getElementById('app')!);
