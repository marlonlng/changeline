import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { relativeTime } from '../../shared/relativeTime';

const now = Date.UTC(2026, 0, 31, 12, 0, 0);
const ago = (seconds: number) => new Date(now - seconds * 1000);

test('relativeTime: less than a minute uses the localized just-now text', () => {
	assert.equal(relativeTime(ago(30), 'en', 'moments ago', now), 'moments ago');
	assert.equal(relativeTime(ago(30), 'de', 'gerade eben', now), 'gerade eben');
});

test('relativeTime: formats minutes, hours, days, months and years in English', () => {
	assert.equal(relativeTime(ago(5 * 60), 'en', '', now), '5 minutes ago');
	assert.equal(relativeTime(ago(3 * 3600), 'en', '', now), '3 hours ago');
	assert.equal(relativeTime(ago(86400), 'en', '', now), 'yesterday');
	assert.equal(relativeTime(ago(60 * 86400), 'en', '', now), '2 months ago');
	assert.equal(relativeTime(ago(730 * 86400), 'en', '', now), '2 years ago');
});

test('relativeTime: formats in German', () => {
	assert.equal(relativeTime(ago(5 * 60), 'de', '', now), 'vor 5 Minuten');
	assert.equal(relativeTime(ago(3 * 3600), 'de', '', now), 'vor 3 Stunden');
	assert.equal(relativeTime(ago(86400), 'de', '', now), 'gestern');
	assert.equal(relativeTime(ago(2 * 86400), 'de', '', now), 'vorgestern');
});
