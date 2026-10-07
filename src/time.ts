function pad(n: number): string {
	return n.toString().padStart(2, "0");
}

/** Local `YYYY-MM-DD HH:MM`, matching the timestamp format signals carry. */
export function localTimestamp(date: Date = new Date()): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
