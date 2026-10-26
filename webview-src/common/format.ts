import { relativeTime } from '../../src/shared/relativeTime';
import { language, t } from './l10n';

export function formatDate(unix: number, style: 'relative' | 'absolute' = 'absolute'): string {
	const d = new Date(unix * 1000);
	const days = Math.round((Date.now() - d.getTime()) / 86400000);
	if (style === 'relative' && days < 7) {
		return days === 1 ? t('Yesterday {0}', time(d)) : relativeTime(d, language, t('moments ago'));
	}
	const now = new Date();
	if (d.toDateString() === now.toDateString()) {
		return t('Today {0}', time(d));
	}
	const yesterday = new Date(now);
	yesterday.setDate(now.getDate() - 1);
	if (d.toDateString() === yesterday.toDateString()) {
		return t('Yesterday {0}', time(d));
	}
	return new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'short' }).format(d);
}

function time(d: Date): string {
	return new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit' }).format(d);
}

export function fullDate(unix: number): string {
	return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(unix * 1000));
}

export function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function basename(p: string): string {
	const i = p.lastIndexOf('/');
	return i === -1 ? p : p.slice(i + 1);
}

export function dirname(p: string): string {
	const i = p.lastIndexOf('/');
	return i === -1 ? '' : p.slice(0, i);
}

export function initials(name: string): string {
	return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
}
