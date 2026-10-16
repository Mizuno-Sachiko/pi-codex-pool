import {
	ALL_DAYS,
	validDate,
	type DayOfWeek,
	type MemberSchedule,
	type PoolConfig,
	type ScheduleWindow,
} from "./config.mts";

const JS_DAY_TO_DOW: DayOfWeek[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function getDayOfWeek(date: Date): DayOfWeek {
	return JS_DAY_TO_DOW[date.getDay()];
}

function isInHourRange(hour: number, [start, end]: [number, number]): boolean {
	return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

function isInScheduleWindow(window: ScheduleWindow, now: Date): boolean {
	if (window.days?.length && !window.days.includes(getDayOfWeek(now))) return false;
	if (window.hours && !isInHourRange(now.getHours(), window.hours)) return false;
	const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	return (
		(!window.dateRange?.from || date >= window.dateRange.from) && (!window.dateRange?.to || date <= window.dateRange.to)
	);
}

function getWindowRemainingMs(window: ScheduleWindow, now: Date): number {
	if (!window.hours) return Infinity;
	const end = new Date(now);
	end.setHours(window.hours[1], 0, 0, 0);
	// Advancing the local date preserves the closing hour across daylight-saving changes.
	if (end.getTime() <= now.getTime()) end.setDate(end.getDate() + 1);
	return end.getTime() - now.getTime();
}

export function getScheduledMemberState(provider: string, schedule: MemberSchedule | undefined, now: Date) {
	const role = schedule?.role ?? "default";
	const windows = schedule?.windows ?? [];
	if (role === "overflow" || windows.length === 0) {
		return { provider, role, active: true, shortestRemainingMs: Infinity };
	}
	const active = windows.filter((window) => isInScheduleWindow(window, now));
	return {
		provider,
		role,
		active: active.length > 0,
		shortestRemainingMs: Math.min(...active.map((window) => getWindowRemainingMs(window, now))),
	};
}

export function getScheduledMemberOrder(pool: PoolConfig, available: string[], now: Date): string[] {
	const states = available.map((provider) => getScheduledMemberState(provider, pool.memberSchedule?.[provider], now));
	const preferred = states
		.filter((state) => state.role === "preferred" && state.active)
		.sort((left, right) => left.shortestRemainingMs - right.shortestRemainingMs);
	const defaults = states.filter((state) => state.role === "default");
	const overflow = states.filter((state) => state.role === "overflow");
	return [...preferred, ...defaults, ...overflow].map((state) => state.provider);
}

/** Parse the whole input; ignoring a typo could turn a restricted window into an always-active one. */
export function parseScheduleWindowInput(raw: string): ScheduleWindow | null {
	if (!raw.trim()) return null;
	const window: ScheduleWindow = {};
	for (const part of raw.trim().split(/\s+/)) {
		const hours = /^(\d{1,2})-(\d{1,2})$/.exec(part);
		if (hours) {
			const start = Number(hours[1]);
			const end = Number(hours[2]);
			if (window.hours || start > 23 || end > 23 || start === end) return null;
			window.hours = [start, end];
			continue;
		}
		const days = /^([a-z]{3})(?:-([a-z]{3}))?$/.exec(part);
		if (days) {
			const start = ALL_DAYS.indexOf(days[1] as DayOfWeek);
			const end = ALL_DAYS.indexOf((days[2] ?? days[1]) as DayOfWeek);
			if (start < 0 || end < 0) return null;
			window.days ??= [];
			// Inclusive distance also covers a complete seven-day range such as mon-sun.
			const count = ((end - start + ALL_DAYS.length) % ALL_DAYS.length) + 1;
			for (let offset = 0; offset < count; offset++) {
				const day = ALL_DAYS[(start + offset) % ALL_DAYS.length];
				if (!window.days.includes(day)) window.days.push(day);
			}
			continue;
		}
		const dates = part.split("..");
		if (dates.length !== 2 || window.dateRange || !validDate(dates[0]) || !validDate(dates[1]) || dates[0] > dates[1])
			return null;
		window.dateRange = { from: dates[0], to: dates[1] };
	}
	return window;
}
