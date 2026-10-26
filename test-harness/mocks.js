(function () {
	const authors = [
		['Marlon Lange', 'marlon@example.com'],
		['Anna Schmidt', 'anna@example.com'],
		['Jonas Weber', 'jonas@example.com'],
		['Lea Fischer', 'lea@example.com'],
	];
	const subjects = [
		'Add login form validation', 'Fix pagination on news list', 'Update composer dependencies', 'Refactor PageRepository queries',
		'Add caching for menu rendering', 'Fix typo in German translation', 'Improve search result ranking', 'Add unit tests for PriceCalculator',
		'Remove deprecated TypoScript conditions', 'Migrate to Fluid 4 view helpers', 'Fix image cropping in teaser', 'Add REST endpoint for events',
		'Bump version to 2.4.0', 'Clean up unused CSS', 'Fix XSS in comment output', 'Add dark mode styles', 'Speed up sitemap generation',
		'Handle missing translations gracefully', 'Add Matomo tracking opt-out', 'Fix date formatting in event list', 'Introduce ContentBlocks for hero',
		'Update README', 'Fix failing CI on PHP 8.3', 'Add newsletter subscription form', 'Rename FlexForm fields',
	];
	let t = Math.floor(Date.now() / 1000) - 3600 * 24 * 40;
	let n = 0;
	const commits = [];
	const hash = () => {
		n++;
		let h = '';
		let x = n * 7919 + 13;
		for (let i = 0; i < 40; i++) {
			x = (x * 48271) % 2147483647;
			h += (x % 16).toString(16);
		}
		return h;
	};
	const add = (parents, subjectIdx, authorIdx) => {
		t += 3600 * (2 + (n % 7));
		const [a, e] = authors[authorIdx % authors.length];
		const c = { hash: hash(), parents, author: a, authorEmail: e, authorDate: t, committer: a, committerEmail: e, commitDate: t, subject: subjects[subjectIdx % subjects.length] };
		commits.push(c);
		return c.hash;
	};
	let main = add([], 0, 0);
	for (let i = 1; i < 10; i++) main = add([main], i, i);
	let fa = add([main], 10, 1);
	main = add([main], 11, 2);
	fa = add([fa], 12, 1);
	main = add([main], 13, 0);
	fa = add([fa], 14, 1);
	const tag1 = main;
	main = add([main, fa], 15, 0);
	commits[commits.length - 1].subject = "Merge branch 'feature/login' into main";
	for (let i = 16; i < 20; i++) main = add([main], i, i);
	let fb = add([main], 20, 3);
	main = add([main], 21, 2);
	fb = add([fb], 22, 3);
	const tag2 = main;
	let hotfix = add([main], 23, 1);
	main = add([main], 24, 0);
	fb = add([fb], 5, 3);
	main = add([main], 6, 2);
	const originMain = main;
	main = add([main, hotfix], 7, 0);
	commits[commits.length - 1].subject = "Merge branch 'hotfix/xss' into main";
	main = add([main], 8, 0);
	const head = main;
	commits.sort((a, b) => b.commitDate - a.commitDate);

	const refs = [
		{ name: 'refs/heads/main', shortName: 'main', type: 'head', hash: head, current: true, upstream: 'origin/main', ahead: 2, behind: 0 },
		{ name: 'refs/heads/feature/newsletter', shortName: 'feature/newsletter', type: 'head', hash: fb, upstream: 'origin/feature/newsletter', ahead: 1, behind: 0 },
		{ name: 'refs/heads/feature/login', shortName: 'feature/login', type: 'head', hash: fa },
		{ name: 'refs/heads/hotfix/xss', shortName: 'hotfix/xss', type: 'head', hash: hotfix },
		{ name: 'refs/remotes/origin/main', shortName: 'origin/main', type: 'remote', remote: 'origin', hash: originMain },
		{ name: 'refs/remotes/origin/feature/newsletter', shortName: 'origin/feature/newsletter', type: 'remote', remote: 'origin', hash: commits.find((c) => c.hash !== fb && c.author === 'Lea Fischer').hash },
		{ name: 'refs/remotes/origin/develop', shortName: 'origin/develop', type: 'remote', remote: 'origin', hash: tag2 },
		{ name: 'refs/tags/v2.3.0', shortName: 'v2.3.0', type: 'tag', hash: tag1 },
		{ name: 'refs/tags/v2.4.0', shortName: 'v2.4.0', type: 'tag', hash: tag2 },
	];

	const files = (h) => {
		const all = [
			{ path: 'Classes/Controller/LoginController.php', status: 'M' },
			{ path: 'Classes/Domain/Repository/PageRepository.php', status: 'M' },
			{ path: 'Resources/Private/Templates/Login/Form.html', status: 'A' },
			{ path: 'Resources/Private/Language/de.locallang.xlf', status: 'M' },
			{ path: 'Configuration/TypoScript/setup.typoscript', status: 'M' },
			{ path: 'Tests/Unit/PriceCalculatorTest.php', status: 'A' },
			{ path: 'Resources/Public/Css/legacy.css', status: 'D' },
			{ path: 'Classes/Service/MenuService.php', origPath: 'Classes/Service/NavigationService.php', status: 'R' },
			{ path: 'composer.json', status: 'M' },
		];
		const k = parseInt(h.slice(0, 2), 16);
		return all.filter((_, i) => (k >> i) & 1 || i === k % all.length);
	};

	const php = (variant) => `<?php

declare(strict_types=1);

namespace Vendor\\Site\\Controller;

use Psr\\Http\\Message\\ResponseInterface;
use TYPO3\\CMS\\Extbase\\Mvc\\Controller\\ActionController;
${variant ? 'use Vendor\\Site\\Service\\RateLimiter;\n' : ''}
/**
 * Handles the frontend login form.
 */
final class LoginController extends ActionController
{
    public function __construct(
        private readonly UserRepository $users,${variant ? '\n        private readonly RateLimiter $limiter,' : ''}
    ) {
    }

    public function formAction(): ResponseInterface
    {
        $this->view->assign('redirect', $this->request->getArgument('redirect') ?? '/');
        return $this->htmlResponse();
    }

    public function loginAction(string $username, string $password): ResponseInterface
    {
${variant ? "        if (!$this->limiter->allow($username)) {\n            $this->addFlashMessage('Too many attempts, please wait.');\n            return $this->redirect('form');\n        }\n" : ''}        $user = $this->users->findOneByUsername(${variant ? 'trim($username)' : '$username'});
        if ($user === null || !password_verify($password, $user->getPassword())) {
            $this->addFlashMessage(${variant ? "'Invalid username or password.'" : "'Login failed'"});
            return $this->redirect('form');
        }
        $this->session->login($user);
        return $this->redirectToUri('/');
    }

    public function logoutAction(): ResponseInterface
    {
        $this->session->logout();
${variant ? '' : '        $this->addFlashMessage(\'Bye\');\n'}        return $this->redirectToUri('/');
    }
}
`;

	const mergeBase = `function price(item) {
    const net = item.net;
    const tax = 0.19;
    return net * (1 + tax);
}

function format(value) {
    return value.toFixed(2) + ' EUR';
}

export { price, format };
`;
	const mergeLeft = `function price(item) {
    const net = item.net;
    const tax = item.reduced ? 0.07 : 0.19;
    return net * (1 + tax);
}

function format(value) {
    return value.toFixed(2) + ' €';
}

export { price, format };
`;
	const mergeRight = `function price(item, country = 'DE') {
    const net = item.net;
    const tax = rates[country] ?? 0.19;
    return net * (1 + tax);
}

function format(value) {
    return value.toFixed(2) + ' EUR';
}

const rates = { DE: 0.19, AT: 0.2 };

export { price, format };
`;

	const handlers = {
		init: () => document.documentElement.dataset.view === 'pullRequests' ? ({
			repos: [{ root: '/repo', name: 'site-package' }],
			repoRoot: '/repo',
			hosting: { name: 'GitHub', webUrl: 'https://github.com/acme/site-package', kind: 'github' },
			branch: 'feature/rate-limit',
		}) : ({
			id: 'log-1',
			scope: { kind: new URLSearchParams(location.search).get('history') ? 'history' : 'log', path: 'Classes/Controller/LoginController.php' },
			repos: [{ root: '/repo', name: 'site-package' }],
			repoRoot: '/repo',
			user: { name: 'Marlon Lange', email: 'marlon@example.com' },
			refs,
			head,
			branch: 'main',
			favorites: ['main'],
			settings: { dateFormat: 'relative', pageSize: 1000, showHash: false },
		}),
		refs: () => ({ refs, head, branch: 'main', favorites: ['main'] }),
		load: () => ({ commits, hasMore: false }),
		details: (p) => {
			const cs = p.hashes.map((h) => {
				const c = commits.find((x) => x.hash === h);
				return { ...c, body: `${c.subject}\n\nThis change ${c.subject.toLowerCase()} and adds tests.\nRefs: #${parseInt(h.slice(0, 3), 16)}` };
			});
			return { commits: cs, files: files(p.hashes[0]) };
		},
		containing: () => ({ branches: ['main', 'origin/main', 'feature/newsletter'], tags: ['v2.4.0'] }),
		selection: () => undefined,
		branchClick: (p) => (p.ref === 'HEAD' ? head : (refs.find((r) => r.shortName === p.ref) || {}).hash),
		ready: () => {
			const view = document.documentElement.dataset.view;
			if (view === 'diff') {
				return {
					path: 'Classes/Controller/LoginController.php',
					repoName: 'site-package',
					leftTitle: 'HEAD (3f2a9c1e)',
					rightTitle: 'Your version',
					status: 'M',
					left: php(false),
					right: php(true),
					leftMissing: false,
					rightMissing: false,
					binary: false,
					tooLarge: false,
					mode: 'local',
					capabilities: { revert: true, include: true, stage: false, unstage: false, source: true },
					included: true,
					excluded: [],
					fileIndex: 0,
					files: [{ path: 'Classes/Controller/LoginController.php', status: 'M' }, { path: 'composer.json', status: 'M' }, { path: 'Resources/Private/Templates/Login/Form.html', status: 'A' }],
					settings: { whitespace: 'none', sideBySide: new URLSearchParams(location.search).get('unified') ? false : true, collapse: false, highlightWords: true, context: 4 },
					review: new URLSearchParams(location.search).get('review') ? { title: '#128 Add rate limiting to the login form', comments: [
						{ id: '7', author: 'jonas', createdAt: '2026-10-19T11:00:00Z', body: 'Please `trim()` the username before checking the limit.', line: 30, side: 'RIGHT', thread: '7' },
						{ id: '8', author: 'marlon', createdAt: '2026-10-20T08:01:00Z', body: 'Done in f6e5d4c.', line: 30, side: 'RIGHT', thread: '7' },
					] } : undefined,
				};
			}
			if (view === 'merge') {
				return { title: "Merging feature/vat into main", path: 'src/price.js', base: mergeBase, left: mergeLeft, right: mergeRight, leftTitle: 'Your version (main)', rightTitle: 'Changes from feature/vat' };
			}
			if (view === 'conflicts') {
				return {
					multiple: false,
					groups: [{
						root: '/repo', name: 'site-package', title: 'Merging feature/vat into main', left: 'Your version (main)', right: 'Changes from feature/vat', operation: 'merge',
						files: [
							{ path: 'src/price.js', code: 'UU', ours: 'modified', theirs: 'modified', status: 'U' },
							{ path: 'Configuration/TypoScript/setup.typoscript', code: 'UU', ours: 'modified', theirs: 'modified', status: 'U' },
							{ path: 'Resources/Public/Css/legacy.css', code: 'UD', ours: 'modified', theirs: 'deleted', status: 'U' },
						],
					}],
				};
			}
			if (view === 'commitMessage') {
				return {
					message: 'Add rate limiting to the login form\n\nThe login action now refuses requests after five failed attempts\nwithin ten minutes per username.',
					amend: false,
					options: { signOff: false, runHooks: true, author: '', analyzeCode: false, checkTodo: false },
					summary: '2 modified, 1 added',
					count: 3,
					staging: false,
					busy: false,
					hasRepository: true,
					branch: 'main',
					operation: new URLSearchParams(location.search).get('op') ? 'Merge in progress' : undefined,
					conflicts: new URLSearchParams(location.search).get('op') ? 2 : 0,
					subjectLimit: 72,
					bodyLimit: 72,
					showInspections: true,
				};
			}
			if (view === 'push') {
				return {
					protectedBranches: ['main', 'master'],
					pushTags: 'none',
					runHooks: true,
					targets: [{
						root: '/repo', name: 'site-package', branch: 'main', source: 'HEAD', sourceLabel: 'main', remotes: ['origin', 'upstream'], remote: 'origin', remoteBranch: 'main', exists: true, hasUpstream: true, selected: true,
						commits: commits.slice(0, 2),
					}, {
						root: '/repo2', name: 'theme', branch: 'feature/dark-mode', source: 'HEAD', sourceLabel: 'feature/dark-mode', remotes: ['origin'], remote: 'origin', remoteBranch: 'feature/dark-mode', exists: false, hasUpstream: false, selected: true,
						commits: commits.slice(5, 8),
					}],
				};
			}
			if (view === 'rebase') {
				return {
					branch: 'feature/newsletter',
					base: commits[9].hash,
					commits: commits.slice(0, 6).map((c) => ({ ...c, body: `${c.subject}\n\nDetails about ${c.subject.toLowerCase()}.` })),
					preset: { [commits[2].hash]: { action: 'squash' }, [commits[4].hash]: { action: 'reword', message: 'Reworded message' } },
				};
			}
			if (view === 'compare') {
				return {
					title: 'Compare main with feature/newsletter', leftLabel: 'main', rightLabel: 'feature/newsletter', swappable: true,
					files: files('ff'),
					sections: [
						{ title: 'Commits in feature/newsletter that are not in main', commits: commits.slice(3, 6) },
						{ title: 'Commits in main that are not in feature/newsletter', commits: commits.slice(0, 2) },
					],
				};
			}
			return null;
		},
		files: (p) => files(p.hash || 'a1'),
		user: () => 'marlon',
		list: () => [
			{ number: 128, title: 'Add rate limiting to the login form', state: 'open', draft: false, author: { login: 'marlon' }, createdAt: '2026-10-19T09:00:00Z', updatedAt: new Date(Date.now() - 3600e3 * 3).toISOString(), url: 'https://github.com/acme/site-package/pull/128', headRef: 'feature/rate-limit', baseRef: 'main', labels: ['security', 'backend'], commentsCount: 4 },
			{ number: 127, title: 'Migrate news list to Fluid 4 view helpers', state: 'open', draft: true, author: { login: 'anna' }, createdAt: '2026-10-17T09:00:00Z', updatedAt: new Date(Date.now() - 86400e3).toISOString(), url: '#', headRef: 'feature/fluid4', baseRef: 'main', labels: ['frontend'] },
			{ number: 125, title: 'Fix XSS in comment output', state: 'merged', draft: false, author: { login: 'jonas' }, createdAt: '2026-10-12T09:00:00Z', updatedAt: new Date(Date.now() - 86400e3 * 5).toISOString(), url: '#', headRef: 'hotfix/xss', baseRef: 'main', labels: [] },
			{ number: 121, title: 'Experimental GraphQL endpoint', state: 'closed', draft: false, author: { login: 'lea' }, createdAt: '2026-10-01T09:00:00Z', updatedAt: new Date(Date.now() - 86400e3 * 12).toISOString(), url: '#', headRef: 'spike/graphql', baseRef: 'main', labels: ['wontfix'] },
		],
		details: (p) => {
			if (document.documentElement.dataset.view !== 'pullRequests') {
				const cs = p.hashes.map((h) => {
					const c = commits.find((x) => x.hash === h);
					return { ...c, body: `${c.subject}\n\nThis change ${c.subject.toLowerCase()} and adds tests.\nRefs: #${parseInt(h.slice(0, 3), 16)}` };
				});
				return { commits: cs, files: files(p.hashes[0]) };
			}
			return {
				number: 128, title: 'Add rate limiting to the login form', state: 'open', draft: false, author: { login: 'marlon' }, createdAt: '2026-10-19T09:00:00Z', updatedAt: '2026-10-21T09:00:00Z', url: '#', headRef: 'feature/rate-limit', baseRef: 'main', labels: ['security'],
				body: 'The login action now refuses requests after **five failed attempts** within ten minutes.\n\n- adds `RateLimiter` service\n- adds unit tests\n\nCloses #97',
				mergeable: true,
				checks: { state: 'success', total: 3 },
				reviewers: [{ user: { login: 'anna' }, state: 'approved' }, { user: { login: 'jonas' }, state: 'changes_requested' }, { user: { login: 'lea' }, state: 'pending' }],
				timeline: [
					{ id: 'k1', kind: 'commit', author: { login: 'marlon' }, createdAt: '2026-10-19T09:00:00Z', body: 'Add RateLimiter service', sha: 'a1b2c3d4e5f6' },
					{ id: 'c1', kind: 'comment', author: { login: 'anna' }, createdAt: '2026-10-19T10:00:00Z', body: 'Nice! Could we make the limit configurable via TypoScript?' },
					{ id: '7', kind: 'reviewComment', author: { login: 'jonas' }, createdAt: '2026-10-19T11:00:00Z', body: 'Please `trim()` the username before checking the limit.', path: 'Classes/Controller/LoginController.php', line: 30, diffHunk: '@@ -26,6 +26,11 @@\n     public function loginAction(string $username, string $password): ResponseInterface\n     {\n+        if (!$this->limiter->allow($username)) {' },
					{ id: 'r1', kind: 'review', author: { login: 'jonas' }, createdAt: '2026-10-19T11:01:00Z', state: 'CHANGES_REQUESTED', body: '' },
					{ id: 'k2', kind: 'commit', author: { login: 'marlon' }, createdAt: '2026-10-20T08:00:00Z', body: 'Trim username', sha: 'f6e5d4c3b2a1' },
					{ id: 'r2', kind: 'review', author: { login: 'anna' }, createdAt: '2026-10-20T09:00:00Z', state: 'APPROVED', body: 'LGTM' },
				],
				commits: [{ sha: 'a1b2c3d4e5f6', message: 'Add RateLimiter service', author: 'Marlon Lange', date: '2026-10-19T09:00:00Z' }, { sha: 'f6e5d4c3b2a1', message: 'Trim username', author: 'Marlon Lange', date: '2026-10-20T08:00:00Z' }],
				files: [
					{ path: 'Classes/Controller/LoginController.php', status: 'M', additions: 12, deletions: 2 },
					{ path: 'Classes/Service/RateLimiter.php', status: 'A', additions: 48, deletions: 0 },
					{ path: 'Tests/Unit/Service/RateLimiterTest.php', status: 'A', additions: 61, deletions: 0 },
				],
			};
		},
		commitFiles: () => files('5c'),
	};

	window.CHANGELINE_MOCK = {
		initial(view) {
			if (view === 'dialog') {
				const which = new URLSearchParams(location.search).get('dialog') || 'branch';
				if (which === 'reset') {
					return {
						title: 'Git Reset', description: 'Reset main to 3f2a9c1e "Add caching for menu rendering"', okLabel: 'Reset',
						fields: [{ id: 'mode', type: 'radio', label: 'Reset type:', value: 'mixed', options: [
							{ value: 'soft', label: 'Soft', description: 'Files will not change, differences will be staged for commit.' },
							{ value: 'mixed', label: 'Mixed', description: 'Files will not change, differences will not be staged.' },
							{ value: 'hard', label: 'Hard', description: 'Files will be reverted to the state of the selected commit. Local changes will be lost.' },
							{ value: 'keep', label: 'Keep', description: 'Files will be reverted to the state of the selected commit, but local changes will be kept intact.' },
						] }],
					};
				}
				if (which === 'rollback') {
					return {
						title: 'Rollback Changes', okLabel: 'Rollback', width: 640,
						fields: [
							{ id: 'files', type: 'checklist', label: '3 files', options: files('ff').slice(0, 3).map((f) => ({ value: f.path, label: f.path.split('/').pop(), description: `${f.status} · ${f.path.split('/').slice(0, -1).join('/')}` })) },
							{ id: 'deleteAdded', type: 'checkbox', label: 'Delete local copies of added files', value: false },
						],
					};
				}
				return {
					title: 'Create New Branch from main', okLabel: 'Create', width: 520, liveValidation: true,
					fields: [
						{ id: 'name', type: 'text', label: 'New branch name:', value: 'feature/rate-limit', required: true, focus: true },
						{ id: 'checkout', type: 'checkbox', label: 'Checkout branch', value: true },
						{ id: 'overwrite', type: 'checkbox', label: 'Overwrite existing branch', value: false },
					],
				};
			}
			return null;
		},
	};

	window.acquireVsCodeApi = () => ({
		state: undefined,
		getState() {
			return this.state;
		},
		setState(s) {
			this.state = s;
		},
		postMessage(msg) {
			if (msg.kind !== 'request') {
				return;
			}
			const h = handlers[msg.method];
			const result = h ? h(msg.params || {}) : undefined;
			setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: { kind: 'response', id: msg.id, result } })), 10);
		},
	});
})();
