import type { BucketSnapshot } from "./quota";
import type { CreditsSettings } from "./settings";
import type { StoreState } from "./store";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Ignore hourly rates measured over less than this; too noisy to show. */
const MIN_RATE_SPAN_MS = 5 * 60 * 1000;
/** Runs out within this many days of the reset → warning. */
const PACE_WARNING_DAYS = 3;

export type Pace = "ok" | "warning" | "over";

/** Nerd Font Octicons: nf-oct-copilot / copilot_warning / copilot_error. */
const NERD_ICONS: Record<Pace, string> = { ok: "", warning: "", over: "" };
const TEXT_ICONS: Record<Pace, string> = { ok: "Copilot", warning: "Copilot!", over: "Copilot!!" };

export interface CreditsView {
	remaining: number;
	entitlement: number;
	/** Account-wide credits per hour over the last hour, all agents. */
	perHour?: number;
	/** Average credits per day since the last reset. */
	perDay?: number;
	/** Linear estimate: remaining ÷ perDay. */
	daysLeft?: number;
	resetAt?: number;
	pace: Pace;
}

export function usedCredits(bucket: BucketSnapshot): number {
	return Math.max(0, bucket.entitlement - bucket.remaining);
}

/** The month-long period ending at `resetAt`. */
function periodStart(resetAt: number): number {
	const start = new Date(resetAt);
	start.setUTCMonth(start.getUTCMonth() - 1);
	return start.getTime();
}

function hourlyRate(state: StoreState, now: number, resetAt: number | undefined): number | undefined {
	const since = now - HOUR_MS;
	// Only compare observations from the same billing period; usage drops at reset.
	const window = state.history.filter(entry => entry.at >= since && entry.resetAt === resetAt);
	if (window.length < 2) return undefined;
	const first = window[0];
	const last = window[window.length - 1];
	const span = last.at - first.at;
	if (span < MIN_RATE_SPAN_MS) return undefined;
	return (Math.max(0, last.used - first.used) / span) * HOUR_MS;
}

export function computeView(bucket: BucketSnapshot, state: StoreState, now: number): CreditsView {
	const resetAt = state.latest?.resetAt;
	const used = usedCredits(bucket);
	let perDay: number | undefined;
	let daysLeft: number | undefined;
	if (resetAt !== undefined) {
		const elapsed = now - periodStart(resetAt);
		if (elapsed > 0) {
			perDay = (used / elapsed) * DAY_MS;
			if (perDay > 0) daysLeft = bucket.remaining / perDay;
		}
	}
	let pace: Pace = "ok";
	if (daysLeft !== undefined && resetAt !== undefined) {
		const daysToReset = (resetAt - now) / DAY_MS;
		if (daysLeft < daysToReset - PACE_WARNING_DAYS) pace = "over";
		else if (daysLeft < daysToReset) pace = "warning";
	}
	return {
		remaining: bucket.remaining,
		entitlement: bucket.entitlement,
		perHour: hourlyRate(state, now, resetAt),
		perDay,
		daysLeft,
		resetAt,
		pace,
	};
}

/** 420 → "420", 1400 → "1.4k", 112660 → "112.7k"; exact thousands-separated when `exact`. */
function formatAmount(value: number, exact = false): string {
	if (exact) return Math.round(value).toLocaleString("en-US");
	if (value < 1000) return value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value).toString();
	return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

function formatReset(resetAt: number): string {
	return new Date(resetAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export type DisplayOptions = Pick<
	CreditsSettings,
	"showRemaining" | "showHourly" | "showDaily" | "showRunway" | "showReset" | "numberStyle"
> & { nerdFont: boolean };

/** ` 112,660/125,000 · 420/h · 561/d · ~201d` (+ `↻ Oct 1` when `showReset`). The icon always shows. */
export function formatStatus(view: CreditsView, options: DisplayOptions): string {
	const icon = (options.nerdFont ? NERD_ICONS : TEXT_ICONS)[view.pace];
	const exact = options.numberStyle === "exact";
	const parts: string[] = [];
	if (options.showRemaining) {
		parts.push(`${formatAmount(view.remaining, exact)}/${formatAmount(view.entitlement, exact)}`);
	}
	if (options.showHourly && view.perHour !== undefined) parts.push(`${formatAmount(view.perHour)}/h`);
	if (options.showDaily && view.perDay !== undefined) parts.push(`${formatAmount(view.perDay)}/d`);
	if (options.showRunway && view.daysLeft !== undefined) parts.push(`~${Math.round(view.daysLeft)}d`);
	if (options.showReset && view.resetAt !== undefined) parts.push(`↻ ${formatReset(view.resetAt)}`);
	return parts.length > 0 ? `${icon} ${parts.join(" · ")}` : icon;
}

export function isNerdFont(theme: unknown): boolean {
    const t = theme as { symbols?: { preset?: string }; getSymbolPreset?: () => string } | undefined;
    return (t?.symbols?.preset ?? t?.getSymbolPreset?.()) === "nerd";
}
