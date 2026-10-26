import '../common/base.css';
import './style.css';
import { render } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { CommitInfo, FileChange } from '../../src/shared/types';
import { FileTree, IconButton, useKeys, useSplitter } from '../common/components';
import { formatDate } from '../common/format';
import { call } from '../common/rpc';
import { t } from '../common/l10n';

type Action = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';

interface Commit extends CommitInfo {
	body: string;
}

interface Entry {
	commit: Commit;
	action: Action;
	message?: string;
}

interface Data {
	branch: string;
	base?: string;
	commits: Commit[];
	preset: Record<string, { action: Action; message?: string }>;
}

const ACTIONS: { id: Action; label: string; key: string; icon: string; title: string }[] = [
	{ id: 'pick', label: t('Pick'), key: 'p', icon: 'check', title: t('Use the commit as is') },
	{ id: 'edit', label: t('Stop to Edit'), key: 'e', icon: 'edit', title: t('Stop after applying the commit to amend it') },
	{ id: 'reword', label: t('Reword'), key: 'r', icon: 'pencil', title: t('Change the commit message') },
	{ id: 'squash', label: t('Squash'), key: 's', icon: 'fold-down', title: t('Meld into the previous (older) commit and combine messages') },
	{ id: 'fixup', label: t('Fixup'), key: 'f', icon: 'fold', title: t('Meld into the previous (older) commit, discard this message') },
	{ id: 'drop', label: t('Drop'), key: 'd', icon: 'trash', title: t('Remove the commit') },
];

function App() {
	const [data, setData] = useState<Data | null>(null);
	const [entries, setEntries] = useState<Entry[]>([]);
	const [selected, setSelected] = useState(0);
	const [files, setFiles] = useState<FileChange[]>([]);
	const [groupMessages, setGroupMessages] = useState<Record<string, string>>({});
	const [width, onSplit] = useSplitter('rebase', 560, { min: 300 });

	useEffect(() => {
		call<Data>('ready').then((d) => {
			setData(d);
			setEntries(d.commits.map((c) => ({ commit: c, action: d.preset[c.hash]?.action ?? 'pick', message: d.preset[c.hash]?.message })));
			const gm: Record<string, string> = {};
			for (const [h, p] of Object.entries(d.preset)) {
				if (p.message !== undefined && p.action !== 'reword') {
					gm[h] = p.message;
				}
			}
			setGroupMessages(gm);
		});
	}, []);

	const current = entries[selected];
	useEffect(() => {
		if (current) {
			call<FileChange[]>('files', { hash: current.commit.hash }).then(setFiles);
		}
	}, [current?.commit.hash]);

	const todo = useMemo(() => [...entries].reverse(), [entries]);

	const groups = useMemo(() => {
		const result: { head: number; members: number[] }[] = [];
		todo.forEach((e, i) => {
			if ((e.action === 'squash' || e.action === 'fixup') && result.length) {
				result[result.length - 1].members.push(i);
			} else if (e.action !== 'drop') {
				result.push({ head: i, members: [] });
			}
		});
		return result.filter((g) => g.members.length);
	}, [todo]);

	const firstPickIndex = todo.findIndex((e) => e.action !== 'drop');
	const invalid = firstPickIndex >= 0 && (todo[firstPickIndex].action === 'squash' || todo[firstPickIndex].action === 'fixup');

	const setAction = (a: Action) => {
		setEntries((es) => es.map((e, i) => (i === selected ? { ...e, action: a, message: a === 'reword' ? e.message ?? e.commit.body : e.message } : e)));
	};

	const move = (delta: number) => {
		const target = selected + delta;
		if (target < 0 || target >= entries.length) {
			return;
		}
		setEntries((es) => {
			const next = [...es];
			[next[selected], next[target]] = [next[target], next[selected]];
			return next;
		});
		setSelected(target);
	};

	const groupOf = (todoIndex: number) => groups.find((g) => g.head === todoIndex || g.members.includes(todoIndex));
	const defaultGroupMessage = (g: { head: number; members: number[] }) =>
		[todo[g.head], ...g.members.map((m) => todo[m])]
			.filter((e, k) => k === 0 || e.action === 'squash')
			.map((e) => (e.action === 'reword' && e.message ? e.message : e.commit.body))
			.join('\n\n');

	const start = () => {
		const out = todo.map((e) => ({ hash: e.commit.hash, subject: e.commit.subject, action: e.action, message: e.action === 'reword' ? e.message : undefined }));
		for (const g of groups) {
			const hasSquash = g.members.some((m) => todo[m].action === 'squash');
			const key = todo[g.head].commit.hash;
			if (hasSquash || groupMessages[key] !== undefined) {
				const last = g.members[g.members.length - 1];
				out[last] = { ...out[last], message: groupMessages[key] ?? defaultGroupMessage(g) };
			}
		}
		void call('start', { entries: out });
	};

	useKeys(
		(e) => {
			if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) {
				return;
			}
			if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
				e.preventDefault();
				move(e.key === 'ArrowUp' ? -1 : 1);
				return;
			}
			if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
				e.preventDefault();
				setSelected((s) => Math.max(0, Math.min(entries.length - 1, s + (e.key === 'ArrowUp' ? -1 : 1))));
				return;
			}
			if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
				e.preventDefault();
				if (!invalid) {
					start();
				}
				return;
			}
			const a = ACTIONS.find((x) => x.key === e.key.toLowerCase());
			if (a && !e.metaKey && !e.ctrlKey) {
				e.preventDefault();
				setAction(a.id);
			}
		},
	);

	if (!data) {
		return <div class="jg-empty">{t('Loading…')}</div>;
	}
	const currentTodoIndex = entries.length - 1 - selected;
	const currentGroup = current ? groupOf(currentTodoIndex) : undefined;

	return (
		<div class="rebase-view">
			<div class="jg-toolbar">
				{ACTIONS.map((a) => (
					<button class={`jg-btn action-btn${current?.action === a.id ? ' active' : ''}`} title={`${a.title} (${a.key.toUpperCase()})`} onClick={() => setAction(a.id)}>
						{a.label}
					</button>
				))}
				<span class="sep" />
				<IconButton icon="arrow-up" title={t('Move Up (Alt+Up)')} disabled={selected === 0} onClick={() => move(-1)} />
				<IconButton icon="arrow-down" title={t('Move Down (Alt+Down)')} disabled={selected >= entries.length - 1} onClick={() => move(1)} />
				<IconButton
					icon="discard"
					title={t('Reset all actions')}
					onClick={() => {
						setEntries(data.commits.map((c) => ({ commit: c, action: 'pick' })));
						setGroupMessages({});
					}}
				/>
			</div>
			<div class="jg-split-h body">
				<div class="list jg-focus-within" tabIndex={0} style={{ width: `${width}px` }}>
					{entries.map((e, i) => (
						<div class={`jg-row entry action-${e.action}${i === selected ? ' selected' : ''}`} onClick={() => setSelected(i)}>
							<span class={`badge ${e.action}`}>{e.action}</span>
							<span class="hash">{e.commit.hash.slice(0, 8)}</span>
							<span class="name">{e.action === 'reword' && e.message ? e.message.split('\n')[0] : e.commit.subject}</span>
							<span class="detail">{e.commit.author}</span>
							<span class="detail">{formatDate(e.commit.authorDate, 'relative')}</span>
						</div>
					))}
					<div class="base-row jg-muted">{data.base ? t('onto {0}', data.base.slice(0, 8)) : t('from the root commit')}</div>
				</div>
				<div class="jg-splitter-v" onMouseDown={onSplit as any} />
				<div class="detail-pane">
					{current && current.action === 'reword' && (
						<div class="message-editor">
							<div class="label">{t('New commit message')}</div>
							<textarea
								class="jg-code"
								value={current.message ?? current.commit.body}
								onInput={(ev) => {
									const v = (ev.target as HTMLTextAreaElement).value;
									setEntries((es) => es.map((x, k) => (k === selected ? { ...x, message: v } : x)));
								}}
							/>
						</div>
					)}
					{current && currentGroup && current.action !== 'reword' && (
						<div class="message-editor">
							<div class="label">{t('Message of the squashed commit')}</div>
							<textarea
								class="jg-code"
								value={groupMessages[todo[currentGroup.head].commit.hash] ?? defaultGroupMessage(currentGroup)}
								onInput={(ev) => setGroupMessages({ ...groupMessages, [todo[currentGroup.head].commit.hash]: (ev.target as HTMLTextAreaElement).value })}
							/>
						</div>
					)}
					{current && (
						<div class="commit-details">
							<div class="subject">{current.commit.subject}</div>
							<pre class="body">{current.commit.body.split('\n').slice(1).join('\n').trim()}</pre>
							<div class="jg-muted meta">
								{current.commit.hash.slice(0, 8)} · {current.commit.author} · {new Date(current.commit.authorDate * 1000).toLocaleString()}
							</div>
							<div class="files">
								<FileTree files={files} groupByDir={false} selected={[]} onSelect={() => undefined} onOpen={() => undefined} />
							</div>
						</div>
					)}
				</div>
			</div>
			<div class="footer">
				{invalid ? <span class="jg-error">{t('The oldest commit cannot be squashed or fixed up; there is no commit before it.')}</span> : <span class="jg-muted">{t('Keys: P E R S F D change the action, Alt+↑/↓ moves the commit.')}</span>}
				<span class="spacer" />
				<button class="jg-btn" onClick={() => call('cancel')}>
					{t('Cancel')}
				</button>
				<button class="jg-btn primary" disabled={invalid} onClick={start} title={t('Start Rebasing (⌘↩)')}>
					{t('Start Rebasing')}
				</button>
			</div>
		</div>
	);
}

render(<App />, document.getElementById('app')!);
