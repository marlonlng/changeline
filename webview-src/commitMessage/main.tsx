import '../common/base.css';
import './style.css';
import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Checkbox, IconButton } from '../common/components';
import { call, on, send } from '../common/rpc';
import { t } from '../common/l10n';

interface Options {
	signOff: boolean;
	runHooks: boolean;
	author: string;
	analyzeCode: boolean;
	checkTodo: boolean;
	reformatCode: boolean;
	optimizeImports: boolean;
	gpgSign: boolean;
	runTests: boolean;
}

interface ViewState {
	message?: string;
	amend: boolean;
	options: Options;
	summary: string;
	count: number;
	staging: boolean;
	busy: boolean;
	hasRepository: boolean;
	branch?: string;
	operation?: string;
	conflicts: number;
	subjectLimit: number;
	bodyLimit: number;
	showInspections: boolean;
}

function inspect(message: string, subjectLimit: number, bodyLimit: number): string[] {
	const problems: string[] = [];
	const lines = message.split('\n');
	if (subjectLimit > 0 && lines[0].length > subjectLimit) {
		problems.push(t('Subject line is too long: {0} > {1} characters', lines[0].length, subjectLimit));
	}
	if (lines.length > 1 && lines[1].trim() !== '') {
		problems.push(t('Missing blank line between subject and body'));
	}
	if (bodyLimit > 0) {
		const long = lines.slice(2).findIndex((l) => l.length > bodyLimit);
		if (long >= 0) {
			problems.push(t('Body line {0} is longer than {1} characters', long + 3, bodyLimit));
		}
	}
	return problems;
}

function App() {
	const [st, setSt] = useState<ViewState | null>(null);
	const [message, setMessage] = useState('');
	const [showOptions, setShowOptions] = useState(false);
	const textarea = useRef<HTMLTextAreaElement>(null);
	const sendTimer = useRef<number | undefined>(undefined);

	useEffect(() => {
		const apply = (s: ViewState) => {
			setSt(s);
			if (s.message !== undefined) {
				setMessage(s.message);
			}
		};
		const offState = on<ViewState>('state', apply);
		const offFocus = on('focus', () => textarea.current?.focus());
		call<ViewState>('ready').then(apply);
		return () => {
			offState();
			offFocus();
		};
	}, []);

	const updateMessage = (m: string) => {
		setMessage(m);
		window.clearTimeout(sendTimer.current);
		sendTimer.current = window.setTimeout(() => send('setMessage', { message: m }), 250);
	};

	const problems = useMemo(() => (st && st.showInspections ? inspect(message, st.subjectLimit, st.bodyLimit) : []), [message, st?.subjectLimit, st?.bodyLimit, st?.showInspections]);

	if (!st) {
		return null;
	}
	if (!st.hasRepository) {
		return <div class="jg-empty">{t('No Git repository')}</div>;
	}
	const canCommit = !st.busy && (st.count > 0 || st.amend || !!st.operation) && message.trim().length > 0;
	const commit = (push: boolean) => {
		if (!canCommit) {
			return;
		}
		window.clearTimeout(sendTimer.current);
		send('setMessage', { message });
		send('commit', { message, amend: st.amend, push });
	};
	const setOption = (k: keyof Options, v: unknown) => send('setOptions', { [k]: v });

	return (
		<div class="commit-view">
			{st.operation && (
				<div class="op-banner">
					<span class="codicon codicon-git-merge" />
					<span class="op-text">{st.operation}</span>
					{st.conflicts > 0 && (
						<button class="jg-link" onClick={() => send('resolve')}>
							{t('Resolve conflicts')}
						</button>
					)}
					{st.conflicts === 0 && /Rebasing|Cherry|Revert/.test(st.operation) && (
						<button class="jg-link" onClick={() => send('continue')}>
							{t('Continue')}
						</button>
					)}
					<button class="jg-link" onClick={() => send('abort')}>
						{t('Abort')}
					</button>
				</div>
			)}
			<div class="top-row">
				<Checkbox checked={st.amend} onChange={(v) => send('setAmend', { amend: v })} label={t('Amend')} title={t('Amend the last commit (replace it)')} />
				<span class="spacer" />
				<IconButton icon="history" title={t('Show Commit Message History (⌘M)')} onClick={() => send('history')} />
				<IconButton icon="discard" title={t('Rollback...')} onClick={() => send('rollback')} />
				<IconButton icon="gear" title={t('Commit Options')} active={showOptions} onClick={() => setShowOptions(!showOptions)} />
			</div>
			<textarea
				ref={textarea}
				class={`message jg-code${problems.length ? ' has-problems' : ''}`}
				style={{ '--limit': `${st.subjectLimit}ch` } as any}
				placeholder={st.amend ? t('Commit message (amend)') : t('Commit Message')}
				value={message}
				spellcheck={true}
				onInput={(e) => updateMessage((e.target as HTMLTextAreaElement).value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						commit(e.altKey || e.shiftKey);
					} else if (e.key.toLowerCase() === 'm' && (e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						send('history');
					}
				}}
			/>
			{problems.length > 0 && (
				<div class="problems">
					{problems.map((p) => (
						<div class="problem">
							<span class="codicon codicon-warning" /> {p}
						</div>
					))}
				</div>
			)}
			{showOptions && (
				<div class="options">
					<div class="options-title">{t('Commit Options')}</div>
					<label class="field">
						<span>{t('Author:')}</span>
						<input type="text" placeholder={t('Name <email>')} value={st.options.author} onChange={(e) => setOption('author', (e.target as HTMLInputElement).value)} />
					</label>
					<Checkbox checked={st.options.signOff} onChange={(v) => setOption('signOff', v)} label={t('Sign-off commit')} />
					<Checkbox checked={st.options.runHooks} onChange={(v) => setOption('runHooks', v)} label={t('Run Git hooks')} />
					<Checkbox checked={st.options.gpgSign} onChange={(v) => setOption('gpgSign', v)} label={t('Sign commit with GPG key')} />
					<div class="options-title">{t('Before Commit')}</div>
					<Checkbox checked={st.options.reformatCode} onChange={(v) => setOption('reformatCode', v)} label={t('Reformat code')} />
					<Checkbox checked={st.options.optimizeImports} onChange={(v) => setOption('optimizeImports', v)} label={t('Optimize imports')} />
					<Checkbox checked={st.options.analyzeCode} onChange={(v) => setOption('analyzeCode', v)} label={t('Analyze code (problems in changed files)')} />
					<Checkbox checked={st.options.checkTodo} onChange={(v) => setOption('checkTodo', v)} label={t('Check TODO')} />
					<Checkbox checked={st.options.runTests} onChange={(v) => setOption('runTests', v)} label={t('Run tests (VS Code task)')} />
				</div>
			)}
			<div class="footer">
				<div class="buttons">
					<button class="jg-btn primary" disabled={!canCommit} onClick={() => commit(false)} title={t('Commit (⌘↩)')}>
						{st.busy ? t('Committing…') : st.amend ? t('Amend Commit') : t('Commit')}
					</button>
					<button class="jg-btn" disabled={!canCommit} onClick={() => commit(true)} title={t('Commit and Push (⌥⌘↩)')}>
						{st.amend ? t('Amend and Push…') : t('Commit and Push…')}
					</button>
				</div>
				<div class="summary jg-muted" title={st.branch ? t('Branch: {0}', st.branch) : undefined}>
					{st.summary}
					{st.branch && <span class="branch"> · {st.branch}</span>}
				</div>
			</div>
		</div>
	);
}

render(<App />, document.getElementById('app')!);
