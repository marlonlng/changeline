import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { completeWord, wordAt, wrapTyping } from '../../shared/commitMessage';
import { hostingIssueRules, linkIssues } from '../../shared/issueLinks';

test('wrapTyping: breaks a body line at its last space before the margin, never the subject', () => {
	const text = 'Subject\n\nThis body line gets longer than ten';
	const r = wrapTyping(text, text.length, 20);
	assert.deepEqual(r, { text: 'Subject\n\nThis body line gets\nlonger than ten', caret: text.length });
	assert.equal(wrapTyping('A very long subject line that keeps going', 40, 10), undefined);
	assert.equal(wrapTyping('S\n\nshort', 8, 20), undefined);
	assert.equal(wrapTyping('S\n\nnospacesatalluntiltheend', 25, 10), undefined);
});

test('wordAt and completeWord: file names complete by basename first', () => {
	assert.deepEqual(wordAt('Fix Login', 9), { start: 4, word: 'Login' });
	assert.deepEqual(wordAt('see src/a.ts', 12), { start: 4, word: 'src/a.ts' });
	const files = ['Classes/Controller/LoginController.php', 'LoginController.php', 'Tests/LoginTest.php', 'logs/app.log'];
	assert.deepEqual(completeWord('Login', files), ['LoginController.php', 'Tests/LoginTest.php', 'Classes/Controller/LoginController.php']);
	assert.deepEqual(completeWord('Classes/C', files), ['Classes/Controller/LoginController.php']);
	assert.deepEqual(completeWord('LoginController.php', ['LoginController.php']), []);
});

test('linkIssues: issue references become links, overlapping rules keep the first match', () => {
	const rules = [{ pattern: '[A-Z]+-\\d+', link: 'https://jira.example/browse/$0' }, ...hostingIssueRules('github', 'https://github.com/acme/site/')];
	assert.deepEqual(linkIssues('Fixes ABC-12 and #7, not a#8', rules), [
		{ text: 'Fixes ' },
		{ text: 'ABC-12', url: 'https://jira.example/browse/ABC-12' },
		{ text: ' and ' },
		{ text: '#7', url: 'https://github.com/acme/site/issues/7' },
		{ text: ', not a#8' },
	]);
	assert.deepEqual(linkIssues('!3 and #4', hostingIssueRules('gitlab', 'https://gitlab.com/g/p')).filter((p) => p.url).map((p) => p.url), ['https://gitlab.com/g/p/-/merge_requests/3', 'https://gitlab.com/g/p/-/issues/4']);
	assert.deepEqual(linkIssues('plain', [{ pattern: '(', link: 'x' }]), [{ text: 'plain' }]);
});
