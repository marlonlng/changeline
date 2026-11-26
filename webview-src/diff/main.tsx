import '../common/base.css';
import './style.css';
import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { HighlightMode, WhitespaceMode } from '../../src/shared/diff';
import { chunkForLineChange, LineChange } from '../../src/shared/lineChanges';
import { linkIssues } from '../../src/shared/issueLinks';
import { buildBlocks, buildModel, DiffData, markClass, renderSides, renderUnified, Settings } from '../common/diffRender';
import { Checkbox, Icon, IconButton, useKeys } from '../common/components';
import { basename, dirname, fullDate } from '../common/format';
import { call, on } from '../common/rpc';
import { plural, t } from '../common/l10n';
import { LinkedPanes } from '../common/linkedPanes';
import { measureMarks, OverviewRuler } from '../common/overview';

function App() {
	const [data, setData] = useState<DiffData | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [settings, setSettings] = useState<Settings | null>(null);
	const [current, setCurrent] = useState(0);
	const [expanded, setExpanded] = useState<Set<number>>(new Set());
	const bodyRef = useRef<HTMLDivElement>(null);
	const leftRef = useRef<HTMLDivElement>(null);
	const svgRef = useRef<SVGSVGElement>(null);
	const actsRef = useRef<HTMLDivElement>(null);
	const linksRef = useRef<LinkedPanes | undefined>(undefined);
	const bandsRef = useRef<Map<number, string>>(new Map());
	const focusRef = useRef<LineChange | undefined>(undefined);
	const [busy, setBusy] = useState(false);
	const [composer, setComposer] = useState<{ line: number; side: 'LEFT' | 'RIGHT'; inReplyTo?: string; text: string } | null>(null);

	useEffect(() => {
		const apply = (d: DiffData) => {
			if (d.focus) {
				focusRef.current = d.focus;
			}
			setData((prev) => {
				if (!prev || prev.path !== d.path || prev.fileIndex !== d.fileIndex) {
					setExpanded(new Set());
					setCurrent(0);
					if (bodyRef.current) {
						bodyRef.current.scrollTop = 0;
					}
				}
				return d;
			});
			setSettings((s) => s ?? d.settings);
			setError(null);
		};
		const off1 = on<DiffData>('data', apply);
		const off2 = on<string>('error', setError);
		call<DiffData>('ready').then(apply, (e) => setError(String(e)));
		return () => {
			off1();
			off2();
		};
	}, []);

	const s = settings ?? data?.settings;
	const model = useMemo(() => (data && s && !data.binary && !data.tooLarge ? buildModel(data, s) : null), [data, s?.whitespace, s?.highlight]);
	const blocks = useMemo(() => (model && s ? buildBlocks(model, s.collapse, s.context, expanded) : []), [model, s?.collapse, s?.context, expanded]);
	const html = useMemo(() => {
		if (!model || !data || !s) {
			return '';
		}
		return s.sideBySide ? renderSides(model, blocks, data, s, current) : renderUnified(model, blocks, data, s, current);
	}, [model, blocks, data, s?.sideBySide, current]);

	const placeActions = () => {
		const links = linksRef.current;
		const layer = actsRef.current;
		if (!links || !layer) {
			return;
		}
		for (const el of layer.querySelectorAll<HTMLElement>('.acts')) {
			const box = links.visibleBox(Number(el.dataset.pane), Number(el.dataset.acts));
			const visible = !!box && box.top + 24 > 0 && box.top < layer.clientHeight;
			el.style.display = visible ? '' : 'none';
			if (box) {
				el.style.top = `${Math.max(0, box.top)}px`;
			}
		}
	};

	useEffect(() => {
		const master = bodyRef.current;
		if (!master) {
			return;
		}
		const top = master.scrollTop;
		if (typeof html === 'string') {
			master.innerHTML = html;
		} else {
			master.innerHTML = html.right;
			if (leftRef.current) {
				leftRef.current.innerHTML = html.left;
			}
			if (actsRef.current) {
				actsRef.current.innerHTML = html.actions;
			}
			bandsRef.current = html.bands;
		}
		master.scrollTop = top;
		linksRef.current?.refresh();
	}, [html]);

	const sideBySide = !!s?.sideBySide;
	const loaded = !!data && !!s;
	useEffect(() => {
		const master = bodyRef.current;
		if (!master) {
			return;
		}
		const panes = sideBySide && leftRef.current ? [leftRef.current, master] : [master];
		const dividers = sideBySide && svgRef.current ? [svgRef.current] : [];
		const links = new LinkedPanes(panes, dividers, (_k, i) => bandsRef.current.get(i), placeActions);
		linksRef.current = links;
		links.refresh();
		return () => {
			links.dispose();
			linksRef.current = undefined;
		};
	}, [sideBySide, loaded]);

	const update = (patch: Partial<Settings>) => {
		const next = { ...s!, ...patch };
		setSettings(next);
		void call('saveSettings', patch);
	};

	const act = async (method: string, params: unknown) => {
		setBusy(true);
		try {
			await call(method, params);
		} catch (e) {
			setError(String((e as Error).message ?? e));
		} finally {
			setBusy(false);
		}
	};

	const scrollToChunk = (i: number) => {
		linksRef.current?.reveal(i);
	};

	const go = (delta: number) => {
		if (!model || !model.chunks.length) {
			return;
		}
		const next = current + delta;
		if (next < 0 || next >= model.chunks.length) {
			if (data && data.files.length > 1) {
				const f = data.fileIndex + delta;
				if (f >= 0 && f < data.files.length) {
					void navigate(f);
				}
			}
			return;
		}
		setCurrent(next);
		setTimeout(() => scrollToChunk(next), 0);
	};

	const navigate = async (index: number) => {
		const d = await call<DiffData | undefined>('navigate', { index });
		if (d) {
			setData(d);
			setExpanded(new Set());
			setCurrent(0);
			if (bodyRef.current) {
				bodyRef.current.scrollTop = 0;
			}
		}
	};

	useEffect(() => {
		if (model && model.chunks.length) {
			setTimeout(() => scrollToChunk(Math.min(current, model.chunks.length - 1)), 0);
		}
	}, [data?.path, data?.fileIndex]);

	useEffect(() => {
		const focus = focusRef.current;
		if (!focus || !model) {
			return;
		}
		focusRef.current = undefined;
		const i = chunkForLineChange(model.chunks, focus);
		if (i >= 0) {
			setCurrent(i);
			setTimeout(() => scrollToChunk(i), 0);
		}
	}, [model]);

	useKeys(
		(e) => {
			if (e.key === 'F7') {
				e.preventDefault();
				go(e.shiftKey ? -1 : 1);
			} else if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && data) {
				e.preventDefault();
				const f = data.fileIndex + (e.key === 'ArrowRight' ? 1 : -1);
				if (f >= 0 && f < data.files.length) {
					void navigate(f);
				}
			} else if (e.key === 'F4' || (e.key === 'ArrowDown' && (e.metaKey || e.ctrlKey))) {
				e.preventDefault();
				void call('openSource', { line: model && model.chunks[current] ? model.chunks[current].newStart + 1 : 1 });
			}
		},
	);

	const onBodyClick = (e: MouseEvent) => {
		const entry = e.target as HTMLElement;
		if (data?.review) {
			const resolve = entry.closest('[data-resolve]') as HTMLElement | null;
			if (resolve) {
				void act('resolveThread', { thread: resolve.dataset.resolve, resolved: resolve.dataset.resolved === '1' });
				return;
			}
			const suggest = entry.closest('[data-suggest]') as HTMLElement | null;
			if (suggest) {
				void act('applySuggestion', { id: suggest.dataset.suggest });
				return;
			}
			const reply = entry.closest('[data-reply]') as HTMLElement | null;
			if (reply) {
				setComposer({ line: Number(reply.dataset.rline), side: reply.dataset.rside as 'LEFT' | 'RIGHT', inReplyTo: reply.dataset.reply, text: '' });
				return;
			}
			const ln = entry.closest('.ln') as HTMLElement | null;
			if (ln && (ln.dataset.line || ln.dataset.oline)) {
				setComposer({ line: Number(ln.dataset.line ?? ln.dataset.oline), side: ln.dataset.line ? 'RIGHT' : 'LEFT', text: '' });
				return;
			}
		}
		const fold = entry.closest('[data-fold]') as HTMLElement | null;
		if (fold) {
			const next = new Set(expanded);
			next.add(Number(fold.dataset.fold));
			setExpanded(next);
			return;
		}
		const btn = entry.closest('[data-action]') as HTMLElement | null;
		if (btn && !busy) {
			const action = btn.dataset.action!;
			const key = btn.dataset.key!;
			if (action === 'move') {
				void act('moveChunk', { key });
				return;
			}
			void act(action === 'revert' ? 'revertChunk' : action === 'stage' ? 'stageChunk' : 'unstageChunk', { key, whitespace: s!.whitespace, split: s!.highlight === 'split' });
			return;
		}
		if (entry instanceof HTMLInputElement && entry.classList.contains('inc')) {
			void act('toggleChunk', { key: entry.dataset.key, included: entry.checked, whitespace: s!.whitespace, split: s!.highlight === 'split' });
			return;
		}
		const chunk = entry.closest('[data-chunk]') as HTMLElement | null;
		if (chunk) {
			setCurrent(Number(chunk.dataset.chunk));
		}
	};

	const onBodyDblClick = (e: MouseEvent) => {
		const element = e.target as HTMLElement;
		const line = element.closest('.line, .u-line') as HTMLElement | null;
		const ln = line?.querySelector('[data-line]') as HTMLElement | null;
		if (ln && data?.capabilities.source) {
			void call('openSource', { line: Number(ln.dataset.line) });
		}
	};

	if (error && !data) {
		return <div class="jg-empty jg-error">{error}</div>;
	}
	if (!data || !s) {
		return <div class="jg-empty">{t('Loading…')}</div>;
	}
	const chunkCount = model?.chunks.length ?? 0;
	const identical = model && chunkCount === 0;
	const eolOnly = identical && data.left !== data.right && !data.leftMissing && !data.rightMissing;
	const lineCount = Math.max(model?.oldLines.length ?? 0, model?.newLines.length ?? 0);
	const lnWidth = `${Math.max(3, String(lineCount).length) + 1}ch`;
	const file = data.files[data.fileIndex];

	return (
		<div class="diff-view">
			<div class="jg-toolbar">
				<IconButton icon="arrow-up" title={t('Previous Difference (Shift+F7)')} disabled={!chunkCount} onClick={() => go(-1)} />
				<IconButton icon="arrow-down" title={t('Next Difference (F7)')} disabled={!chunkCount} onClick={() => go(1)} />
				{data.files.length > 1 && (
					<>
						<span class="sep" />
						<IconButton icon="arrow-left" title={t('Previous File (Alt+Left)')} disabled={data.fileIndex === 0} onClick={() => navigate(data.fileIndex - 1)} />
						<select class="file-select" value={data.fileIndex} onChange={(e) => navigate(Number((e.target as HTMLSelectElement).value))}>
							{data.files.map((f, i) => (
								<option value={i}>
									{basename(f.path)} {dirname(f.path) ? `(${dirname(f.path)})` : ''}
								</option>
							))}
						</select>
						<IconButton icon="arrow-right" title={t('Next File (Alt+Right)')} disabled={data.fileIndex >= data.files.length - 1} onClick={() => navigate(data.fileIndex + 1)} />
						<span class="jg-muted counter">
							{data.fileIndex + 1}/{data.files.length}
						</span>
					</>
				)}
				<span class="sep" />
				<select title={t('Viewer')} value={s.sideBySide ? 'side' : 'unified'} onChange={(e) => update({ sideBySide: (e.target as HTMLSelectElement).value === 'side' })}>
					<option value="side">{t('Side-by-side viewer')}</option>
					<option value="unified">{t('Unified viewer')}</option>
				</select>
				<select title={t('Whitespace')} value={s.whitespace} onChange={(e) => update({ whitespace: (e.target as HTMLSelectElement).value as WhitespaceMode })}>
					<option value="none">{t('Do not ignore')}</option>
					<option value="trim">{t('Trim whitespaces')}</option>
					<option value="all">{t('Ignore whitespaces')}</option>
					<option value="emptyLines">{t('Ignore whitespaces and empty lines')}</option>
					<option value="formatting">{t('Ignore formatting')}</option>
				</select>
				<select title={t('Highlighting')} value={s.highlight} onChange={(e) => update({ highlight: (e.target as HTMLSelectElement).value as HighlightMode })}>
					<option value="words">{t('Highlight words')}</option>
					<option value="lines">{t('Highlight lines')}</option>
					<option value="split">{t('Highlight split changes')}</option>
					<option value="chars">{t('Highlight characters')}</option>
					<option value="none">{t('Do not highlight')}</option>
				</select>
				<IconButton icon="fold" title={t('Collapse unchanged fragments')} active={s.collapse} onClick={() => update({ collapse: !s.collapse })} />
				<IconButton icon="word-wrap" title={t('Use soft wraps')} active={s.softWrap} onClick={() => update({ softWrap: !s.softWrap })} />
				<span class="spacer" />
				{data.capabilities.include && (
					<Checkbox checked={data.included} onChange={(v) => act('includeFile', { included: v })} label={t('Include into commit')} />
				)}
				<span class="jg-muted counter">{data.binary ? t('binary') : identical ? t('no differences') : plural(chunkCount, '{0} difference', '{0} differences')}</span>
				<IconButton icon="go-to-file" title={t('Jump to Source (F4)')} disabled={!data.capabilities.source} onClick={() => call('openSource', { line: model && model.chunks[current] ? model.chunks[current].newStart + 1 : 1 })} />
				<IconButton icon="history" title={t('Show History')} onClick={() => call('showHistory')} />
				<IconButton icon="split-horizontal" title={t('Open in VS Code Diff Editor')} onClick={() => call('openNative')} />
			</div>
			{error && <div class="banner jg-error">{error}</div>}
			{data.commit && (
				<div class="commit-info">
					<div class="commit-message">
						{linkIssues(data.commit.body.trim() ? `${data.commit.subject}\n\n${data.commit.body.trim()}` : data.commit.subject, data.commit.issueRules).map((p) =>
							p.url ? (
								<a class="jg-link" title={p.url} onClick={() => call('openUrl', { url: p.url })}>
									{p.text}
								</a>
							) : (
								p.text
							),
						)}
					</div>
					<div class="jg-muted commit-meta">
						<Icon name="account" /> {data.commit.author} &lt;{data.commit.authorEmail}&gt; · {fullDate(data.commit.authorDate)} · <span class="commit-hash">{data.commit.hash}</span>
					</div>
				</div>
			)}
			<div class="titles" style={{ '--lnw': lnWidth } as any}>
				{s.sideBySide ? (
					<>
						<div class="title l" title={data.leftTitle}>
							<Icon name="git-commit" /> {data.leftMissing ? `${data.leftTitle} (file did not exist)` : data.leftTitle}
						</div>
						<div class="title gutter-title" />
						<div class="title r" title={file?.path}>
							<Icon name={data.mode === 'local' || data.mode === 'unstaged' ? 'edit' : 'git-commit'} /> {data.rightMissing ? `${data.rightTitle} (deleted)` : data.rightTitle}
							<span class="jg-muted path"> {data.path}</span>
						</div>
					</>
				) : (
					<div class="title">
						{data.leftTitle} → {data.rightTitle} <span class="jg-muted path">{data.path}</span>
					</div>
				)}
			</div>
			{data.binary || data.tooLarge ? (
				<div class="jg-empty">
					<p>{data.binary ? t('Binary files differ') : t('File is too large for the diff viewer.')}</p>
					<button class="jg-btn" onClick={() => call('openNative')}>
						{t('Open in VS Code')}
					</button>
				</div>
			) : identical ? (
				<div class="jg-empty">{eolOnly ? t('Contents are identical (only line separators differ)') : data.leftMissing && data.rightMissing ? t('No content') : t('Contents are identical')}</div>
			) : null}
			<div class="diff-scroll" style={{ display: data.binary || data.tooLarge || identical ? 'none' : undefined }} onClick={onBodyClick as any} onDblClick={onBodyDblClick as any}>
				{s.sideBySide ? (
					<div class={`diff-body side jg-code${s.highlight === 'none' ? ' hl-none' : ''}${busy ? ' busy' : ''}${data.review ? ' review' : ''}${s.softWrap ? ' wrap' : ''}`} style={{ '--lnw': lnWidth } as any}>
						<div ref={leftRef} class="pane l" tabIndex={0} />
						<div class="divider">
							<svg ref={svgRef} class="bands" />
							<div ref={actsRef} class="acts-layer" />
						</div>
						<div ref={bodyRef} class="pane r" tabIndex={0} />
					</div>
				) : (
					<div ref={bodyRef} class={`diff-body unified pane jg-code${s.highlight === 'none' ? ' hl-none' : ''}${busy ? ' busy' : ''}${data.review ? ' review' : ''}${s.softWrap ? ' wrap' : ''}`} style={{ '--lnw': lnWidth } as any} tabIndex={0} />
				)}
				<OverviewRuler
					target={bodyRef}
					revision={html}
					measure={(el) => measureMarks(el, '[data-chunk]', markClass)}
					onMark={(i) => {
						setCurrent(i);
						scrollToChunk(i);
					}}
				/>
			</div>
			{data.review && (
				<div class="review-bar">
					{composer ? (
						<div class="composer">
							<div class="composer-title">
								{composer.inReplyTo
									? composer.side === 'RIGHT'
										? t('Reply on line {0} (new version)', composer.line)
										: t('Reply on line {0} (old version)', composer.line)
									: composer.side === 'RIGHT'
										? t('New comment on line {0} (new version)', composer.line)
										: t('New comment on line {0} (old version)', composer.line)}{' '}
								· {data.review.title}
							</div>
							<textarea
								rows={4}
								value={composer.text}
								ref={(el) => {
									if (el && !composer.text) {
										setTimeout(() => el.focus(), 0);
									}
								}}
								onInput={(e) => setComposer({ ...composer, text: (e.target as HTMLTextAreaElement).value })}
								onKeyDown={(e) => {
									if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && composer.text.trim()) {
										e.preventDefault();
										void act('addComment', { line: composer.line, side: composer.side, body: composer.text, inReplyTo: composer.inReplyTo, mode: !composer.inReplyTo && data.review!.pending ? 'review' : 'single' }).then(() => setComposer(null));
									} else if (e.key === 'Escape') {
										setComposer(null);
									}
								}}
							/>
							<div class="composer-buttons">
								<button class="jg-btn" onClick={() => setComposer(null)}>
									{t('Cancel')}
								</button>
								{!composer.inReplyTo && (
									<button
										class={`jg-btn${data.review.pending ? ' primary' : ''}`}
										disabled={busy || !composer.text.trim()}
										onClick={() => act('addComment', { line: composer.line, side: composer.side, body: composer.text, mode: 'review' }).then(() => setComposer(null))}
									>
										{data.review.pending ? t('Add Review Comment') : t('Start Review')}
									</button>
								)}
								<button
									class={`jg-btn${composer.inReplyTo || !data.review.pending ? ' primary' : ''}`}
									disabled={busy || !composer.text.trim()}
									onClick={() => act('addComment', { line: composer.line, side: composer.side, body: composer.text, inReplyTo: composer.inReplyTo, mode: 'single' }).then(() => setComposer(null))}
								>
									{composer.inReplyTo ? t('Reply') : t('Add Single Comment')}
								</button>
							</div>
						</div>
					) : (
						<span class="jg-muted">
							<Icon name="comment-discussion" /> {data.review.title} · {plural(data.review.comments.length, '{0} comment in this file', '{0} comments in this file')}
							{data.review.pending ? ` · ${plural(data.review.pending, '{0} pending review comment', '{0} pending review comments')}` : ''} · {t('click a line number to comment')}
						</span>
					)}
				</div>
			)}
		</div>
	);
}

render(<App />, document.getElementById('app')!);
