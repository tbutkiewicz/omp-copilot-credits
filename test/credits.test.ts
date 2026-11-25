import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { computeView, type DisplayOptions, formatStatus, isNerdFont } from "../src/format";
import { parseCopilotUser, parseQuotaHeaders, type QuotaSnapshot, selectBucket } from "../src/quota";
import { DEFAULT_SETTINGS, resolveSettings } from "../src/settings";
import { mergeSnapshot, readStore, recordSnapshot, type StoreState } from "../src/store";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const RESET = Date.parse("2026-10-01T00:00:00Z");
const OK = "\uf4b8";
const ERR = "\uf4b9";
const NERD: DisplayOptions = { ...DEFAULT_SETTINGS, nerdFont: true };
const TEXT: DisplayOptions = { ...DEFAULT_SETTINGS, nerdFont: false };

// Captured from api.individual.githubcopilot.com (Copilot Free).
const FREE_HEADERS = {
	"content-type": "text/event-stream",
	"x-quota-snapshot-chat": "crUsed=0&ent=200&ov=0.0&ovPerm=false&rem=100.0&rst=2026-10-01T00%3A00%3A00Z&totRem=200.0",
	"x-quota-snapshot-completions":
		"crUsed=0&ent=2000&ov=0.0&ovPerm=false&rem=100.0&rst=2026-10-01T00%3A00%3A00Z&totRem=2000.0",
	"x-quota-snapshot-premium_interactions":
		"crUsed=0&ent=0&ov=0.0&ovPerm=false&rem=0.0&rst=2026-10-01T00%3A00%3A00Z&totRem=0.0",
};

function paidHeaders(remaining: number): Record<string, string> {
	return {
		"x-quota-snapshot-premium_interactions": `crUsed=${125000 - remaining}&ent=125000&ov=0.0&ovPerm=false&rem=${(remaining / 1250).toFixed(1)}&rst=2026-10-01T00%3A00%3A00Z&totRem=${remaining}`,
	};
}

function stateFor(snapshot: QuotaSnapshot, history: StoreState["history"] = []): StoreState {
	return { version: 1, latest: snapshot, history };
}

describe("quota parsing", () => {
	it("parses Copilot Free headers and picks the chat bucket", () => {
		const snapshot = parseQuotaHeaders(FREE_HEADERS, 1);
		expect(snapshot?.resetAt).toBe(RESET);
		expect(snapshot?.buckets.chat).toEqual({ bucket: "chat", entitlement: 200, remaining: 200, unlimited: false });
		expect(selectBucket(snapshot!)?.bucket).toBe("chat");
	});

	it("prefers premium interactions when the plan has them", () => {
		const snapshot = parseQuotaHeaders({ ...FREE_HEADERS, ...paidHeaders(112660) }, 1)!;
		expect(selectBucket(snapshot)).toMatchObject({ bucket: "premium_interactions", remaining: 112660, entitlement: 125000 });
		expect(selectBucket(snapshot, "chat")?.bucket).toBe("chat");
	});

	it("ignores responses without quota headers", () => {
		expect(parseQuotaHeaders({ "content-type": "application/json" }, 1)).toBeUndefined();
	});

	it("parses copilot_internal/user", () => {
		const snapshot = parseCopilotUser(
			{
				quota_reset_date: "2026-10-01",
				quota_snapshots: {
					chat: { entitlement: 200, quota_remaining: 187, remaining: 187, unlimited: false },
					premium_interactions: { entitlement: 0, quota_remaining: 0, remaining: 0, unlimited: false },
				},
			},
			1,
		);
		expect(snapshot?.resetAt).toBe(RESET);
		expect(selectBucket(snapshot!)).toMatchObject({ bucket: "chat", remaining: 187 });
	});
});

describe("burn rate and runway", () => {
	it("computes hourly, daily and days-left for a 125k plan", () => {
		const now = RESET - 8 * DAY; // Sep 23: 22 days into a 30-day period
		const snapshot = parseQuotaHeaders(paidHeaders(112660), now)!;
		const history = [
			{ at: now - HOUR, used: 12340 - 420, resetAt: RESET },
			{ at: now, used: 12340, resetAt: RESET },
		];
		const view = computeView(selectBucket(snapshot)!, stateFor(snapshot, history), now);
		expect(view.perHour).toBeCloseTo(420, 5);
		expect(view.perDay).toBeCloseTo(12340 / 22, 5);
		expect(view.daysLeft).toBeCloseTo(112660 / (12340 / 22), 5);
		expect(view.pace).toBe("ok");
		expect(formatStatus(view, NERD)).toBe(`${OK} 112,660/125,000 · 420/h · 561/d · ~201d`);
	});

	it("warns when the runway ends shortly before the reset and errors well before it", () => {
		const now = RESET - 10 * DAY; // 20 days elapsed
		const tight = parseQuotaHeaders(paidHeaders(40000), now)!; // 85k used → 4.25k/d → ~9.4d left of 10
		expect(computeView(selectBucket(tight)!, stateFor(tight), now).pace).toBe("warning");
		const over = parseQuotaHeaders(paidHeaders(9800), now)!; // 115.2k used → 5.76k/d → ~1.7d left
		const view = computeView(selectBucket(over)!, stateFor(over), now);
		expect(view.pace).toBe("over");
		expect(formatStatus(view, NERD).startsWith(`${ERR} 9,800/125,000`)).toBe(true);
	});

	it("omits rates it cannot measure and uses a text icon without a Nerd Font", () => {
		const now = RESET - 8 * DAY;
		const snapshot = parseQuotaHeaders(FREE_HEADERS, now)!;
		const view = computeView(selectBucket(snapshot)!, stateFor(snapshot), now);
		expect(view.perHour).toBeUndefined();
		expect(view.daysLeft).toBeUndefined();
		expect(formatStatus(view, TEXT)).toBe("Copilot 200/200 · 0/d");
	});

	it("does not measure burn across a reset", () => {
		const now = RESET + HOUR;
		const next = Date.parse("2026-11-01T00:00:00Z");
		const snapshot: QuotaSnapshot = {
			observedAt: now,
			resetAt: next,
			buckets: { premium_interactions: { bucket: "premium_interactions", entitlement: 125000, remaining: 124900, unlimited: false } },
		};
		const history = [
			{ at: now - 50 * 60 * 1000, used: 124000, resetAt: RESET },
			{ at: now, used: 100, resetAt: next },
		];
		expect(computeView(selectBucket(snapshot)!, stateFor(snapshot, history), now).perHour).toBeUndefined();
	});
});

describe("display settings", () => {
	const now = RESET - 8 * DAY;
	const snapshot = parseQuotaHeaders(paidHeaders(112660), now)!;
	const history = [
		{ at: now - HOUR, used: 12340 - 420, resetAt: RESET },
		{ at: now, used: 12340, resetAt: RESET },
	];
	const view = computeView(selectBucket(snapshot)!, stateFor(snapshot, history), now);

	it("toggles each part independently", () => {
		expect(formatStatus(view, { ...NERD, showHourly: false, showDaily: false })).toBe(`${OK} 112,660/125,000 · ~201d`);
		expect(formatStatus(view, { ...NERD, showRemaining: false, showReset: true })).toBe(`${OK} 420/h · 561/d · ~201d · ↻ Oct 1`);
	});

	it("keeps the icon when every part is hidden, so pace still shows", () => {
		const hidden = { showRemaining: false, showHourly: false, showDaily: false, showRunway: false, showReset: false };
		expect(formatStatus(view, { ...NERD, ...hidden })).toBe(OK);
	});

	it("formats compact numbers", () => {
		expect(formatStatus(view, { ...NERD, numberStyle: "compact" })).toBe(`${OK} 112.7k/125k · 420/h · 561/d · ~201d`);
	});

	it("resolves stored values over defaults and ignores junk", () => {
		expect(resolveSettings({}, {})).toEqual(DEFAULT_SETTINGS);
		expect(
			resolveSettings({ showReset: "true", showHourly: false, numberStyle: "compact", visibility: "nope", bucket: 7 }, {}),
		).toEqual({ ...DEFAULT_SETTINGS, showReset: true, showHourly: false, numberStyle: "compact" });
		expect(resolveSettings({ bucket: "chat" }, { COPILOT_CREDITS_BUCKET: "premium_interactions" }).bucket).toBe(
			"premium_interactions",
		);
	});
});

describe("shared store", () => {
	const dirs: string[] = [];
	afterEach(async () => {
		for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
	});

	it("keeps the newest snapshot as latest even when an older one arrives late", () => {
		const newer = parseQuotaHeaders(paidHeaders(100), 2000)!;
		const older = parseQuotaHeaders(paidHeaders(200), 1000)!;
		const state = mergeSnapshot(mergeSnapshot({ version: 1, history: [] }, newer, 124900), older, 124800);
		expect(state.latest).toBe(newer);
		expect(state.history.map(entry => entry.at)).toEqual([1000, 2000]);
	});

	it("round-trips through the file and is shared between writers", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-copilot-credits-"));
		dirs.push(dir);
		const file = path.join(dir, "copilot-credits.json");
		await recordSnapshot(file, parseQuotaHeaders(paidHeaders(113000), 1000)!, 12000);
		await recordSnapshot(file, parseQuotaHeaders(paidHeaders(112660), 2000)!, 12340);
		const state = await readStore(file);
		expect(state.latest?.buckets.premium_interactions?.remaining).toBe(112660);
		expect(state.history).toHaveLength(2);
		expect(await fs.readdir(dir)).toEqual(["copilot-credits.json"]);
	});

	it("treats a missing or corrupt file as empty", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-copilot-credits-"));
		dirs.push(dir);
		const file = path.join(dir, "copilot-credits.json");
		expect(await readStore(file)).toEqual({ version: 1, history: [] });
		await Bun.write(file, "{not json");
		expect(await readStore(file)).toEqual({ version: 1, history: [] });
	});
});

describe("theme symbol preset detection", () => {
    it("reads symbols.preset and falls back to getSymbolPreset", () => {
        expect(isNerdFont({ symbols: { preset: "nerd" } } as never)).toBe(true);
        expect(isNerdFont({ symbols: { preset: "unicode" } } as never)).toBe(false);
        expect(isNerdFont({ getSymbolPreset: () => "nerd" } as never)).toBe(true);
        expect(isNerdFont({} as never)).toBe(false);
    });
});
