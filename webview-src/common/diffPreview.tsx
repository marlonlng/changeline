import '../diff/style.css';
import { useEffect, useMemo, useRef } from 'preact/hooks';
import { buildBlocks, buildModel, DiffData, renderSides, Settings } from './diffRender';
import { Icon } from './components';
import { t } from './l10n';
import { LinkedPanes } from './linkedPanes';

export interface PreviewData {
	path: string;
	left: string | null;
	right: string | null;
	leftTitle: string;
	rightTitle: string;
	binary: boolean;
}

const SETTINGS: Settings = { whitespace: 'none', sideBySide: true, softWrap: false, collapse: false, highlight: 'words', context: 4 };

/** Read-only side-by-side diff of one file, like the diff preview next to the changed files in JetBrains' Git log. */
export function DiffPreview({ data, loading }: { data?: PreviewData; loading: boolean }) {
	const leftRef = useRef<HTMLDivElement>(null);
	const rightRef = useRef<HTMLDivElement>(null);
	const svgRef = useRef<SVGSVGElement>(null);
	const linksRef = useRef<LinkedPanes | undefined>(undefined);
	const bandsRef = useRef<Map<number, string>>(new Map());

	const view = useMemo(() => {
		if (!data || data.binary) {
			return undefined;
		}
		const d: DiffData = {
			path: data.path,
			repoName: '',
			leftTitle: data.leftTitle,
			rightTitle: data.rightTitle,
			status: 'M',
			left: data.left,
			right: data.right,
			leftMissing: data.left === null,
			rightMissing: data.right === null,
			binary: false,
			tooLarge: false,
			mode: 'readonly',
			capabilities: { revert: false, include: false, stage: false, unstage: false, source: false },
			included: false,
			excluded: [],
			fileIndex: 0,
			files: [],
			settings: SETTINGS,
		};
		const model = buildModel(d, SETTINGS);
		return { sides: renderSides(model, buildBlocks(model, false, SETTINGS.context, new Set()), d, SETTINGS, -1), lines: Math.max(model.oldLines.length, model.newLines.length) };
	}, [data]);

	useEffect(() => {
		if (!leftRef.current || !rightRef.current || !svgRef.current) {
			return;
		}
		const links = new LinkedPanes([leftRef.current, rightRef.current], [svgRef.current], (_k, i) => bandsRef.current.get(i));
		linksRef.current = links;
		return () => {
			links.dispose();
			linksRef.current = undefined;
		};
	}, [!!view]);

	useEffect(() => {
		if (!view || !leftRef.current || !rightRef.current) {
			return;
		}
		leftRef.current.innerHTML = view.sides.left;
		rightRef.current.innerHTML = view.sides.right;
		bandsRef.current = view.sides.bands;
		leftRef.current.scrollTop = 0;
		rightRef.current.scrollTop = 0;
		linksRef.current?.refresh();
		linksRef.current?.reveal(0);
	}, [view]);

	if (!data) {
		return <div class="jg-empty">{loading ? t('Loading…') : t('Select a file to see its diff')}</div>;
	}
	if (!view) {
		return <div class="jg-empty">{t('Binary files differ')}</div>;
	}
	const lnw = `${Math.max(3, String(view.lines).length) + 1}ch`;
	return (
		<div class="diff-preview">
			<div class="titles" style={{ '--lnw': lnw } as any}>
				<div class="title l" title={data.leftTitle}>
					<Icon name="git-commit" /> {data.leftTitle}
				</div>
				<div class="title gutter-title" />
				<div class="title r" title={data.path}>
					<Icon name="git-commit" /> {data.rightTitle}
					<span class="jg-muted path"> {data.path}</span>
				</div>
			</div>
			<div class="diff-body side jg-code" style={{ '--lnw': lnw } as any}>
				<div ref={leftRef} class="pane l" tabIndex={0} />
				<div class="divider">
					<svg ref={svgRef} class="bands" />
				</div>
				<div ref={rightRef} class="pane r" tabIndex={0} />
			</div>
		</div>
	);
}
