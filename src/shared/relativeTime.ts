/** "5 minutes ago" in the given language; `justNow` is the localized text for less than a minute. */
export function relativeTime(date: Date, language: string, justNow: string, now = Date.now()): string {
	const sec = Math.round((now - date.getTime()) / 1000);
	if (sec < 60) {
		return justNow;
	}
	const format = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
	const min = Math.round(sec / 60);
	if (min < 60) {
		return format.format(-min, 'minute');
	}
	const hours = Math.round(min / 60);
	if (hours < 24) {
		return format.format(-hours, 'hour');
	}
	const days = Math.round(hours / 24);
	if (days < 30) {
		return format.format(-days, 'day');
	}
	const months = Math.round(days / 30);
	if (months < 12) {
		return format.format(-months, 'month');
	}
	return format.format(-Math.round(days / 365), 'year');
}
