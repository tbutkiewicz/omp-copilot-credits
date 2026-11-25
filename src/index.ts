/**
 * omp-copilot-credits — show remaining GitHub Copilot AI credits in the OMP status line.
 *
 *   112,660/125,000 · 420/h · 561/d · ~201d
 *
 * Numbers are account-wide (they come from GitHub, not from this session), and
 * a shared store lets concurrent OMP agents contribute to one burn-rate history.
 * Which parts show is configurable; see `omp.settings` in package.json.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { computeView, formatStatus, isNerdFont, usedCredits } from "./format";
import { parseCopilotUser, parseQuotaHeaders, type QuotaSnapshot, selectBucket } from "./quota";
import { type CreditsSettings, DEFAULT_SETTINGS, resolveSettings } from "./settings";
import { defaultStorePath, readStore, recordSnapshot, type StoreState } from "./store";

const PLUGIN_NAME = "omp-copilot-credits";
const STATUS_KEY = "copilot-credits";
const PROVIDER = "github-copilot";
/** Re-render cadence: picks up model switches, setting changes, and other agents' writes (local reads only). */
const REFRESH_INTERVAL_MS = 30_000;
/** Fetch from GitHub on startup when the shared snapshot is older than this. */
const STALE_AFTER_MS = 5 * 60 * 1000;

function bucketFor(snapshot: QuotaSnapshot, settings: CreditsSettings) {
	return selectBucket(snapshot, settings.bucket === "auto" ? undefined : settings.bucket);
}

/** `https://api.github.com`, or `https://api.<domain>` for GitHub Enterprise logins. */
function githubApiBase(enterpriseUrl: string | undefined): string {
	return enterpriseUrl ? `https://api.${enterpriseUrl.replace(/^https?:\/\//, "")}` : "https://api.github.com";
}

async function fetchSnapshot(ctx: ExtensionContext): Promise<QuotaSnapshot | undefined> {
	const raw = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
	if (!raw) return undefined;
	let token = raw;
	let enterpriseUrl: string | undefined;
	try {
		const parsed = JSON.parse(raw) as { token?: unknown; enterpriseUrl?: unknown };
		if (typeof parsed.token === "string") token = parsed.token;
		if (typeof parsed.enterpriseUrl === "string") enterpriseUrl = parsed.enterpriseUrl;
	} catch {}
	const response = await fetch(`${githubApiBase(enterpriseUrl)}/copilot_internal/user`, {
		headers: { Authorization: `token ${token}`, Accept: "application/json", "User-Agent": PLUGIN_NAME },
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) return undefined;
	return parseCopilotUser(await response.json(), Date.now());
}

export default function copilotCredits(pi: ExtensionAPI) {
	pi.setLabel("Copilot Credits");
	const storePath = process.env.COPILOT_CREDITS_STORE ?? defaultStorePath();
	let lastState: StoreState | undefined;
	let settings: CreditsSettings = resolveSettings({});

	const loadSettings = async (ctx: ExtensionContext): Promise<void> => {
		settings = resolveSettings(await getPluginSettings(PLUGIN_NAME, ctx.cwd).catch(() => ({ ...DEFAULT_SETTINGS })));
	};

	const render = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		const latest = lastState?.latest;
		const bucket = latest ? bucketFor(latest, settings) : undefined;
		const visible = settings.visibility === "always" || ctx.model?.provider === PROVIDER;
		if (!visible || !lastState || !bucket) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const view = computeView(bucket, lastState, Date.now());
        ctx.ui.setStatus(STATUS_KEY, formatStatus(view, { ...settings, nerdFont: isNerdFont(ctx.ui.theme) }));
	};

	const refresh = async (ctx: ExtensionContext): Promise<void> => {
		await loadSettings(ctx);
		lastState = await readStore(storePath);
		render(ctx);
	};

	const record = async (ctx: ExtensionContext, snapshot: QuotaSnapshot): Promise<void> => {
		const bucket = bucketFor(snapshot, settings);
		lastState = await recordSnapshot(storePath, snapshot, bucket ? usedCredits(bucket) : undefined);
		render(ctx);
	};

	let stopTimer: (() => void) | undefined;

	pi.on("session_start", async (_event, ctx) => {
		await refresh(ctx);
		stopTimer?.();
		const timer = ctx.setInterval(() => void refresh(ctx), REFRESH_INTERVAL_MS);
		stopTimer = () => ctx.clearTimer(timer);
		const age = lastState?.latest ? Date.now() - lastState.latest.observedAt : Number.POSITIVE_INFINITY;
		if (age > STALE_AFTER_MS) {
			const snapshot = await fetchSnapshot(ctx).catch(() => undefined);
			if (snapshot) await record(ctx, snapshot);
		}
	});

	pi.on("session_shutdown", () => {
		stopTimer?.();
		stopTimer = undefined;
	});

	pi.on("after_provider_response", async (event, ctx) => {
		const snapshot = parseQuotaHeaders(event.headers, Date.now());
		if (snapshot) await record(ctx, snapshot);
	});

	pi.on("turn_end", async (_event, ctx) => {
		render(ctx);
	});

	pi.registerCommand("copilot-credits", {
		description: "Refresh GitHub Copilot credit usage from GitHub",
		handler: async (_args, ctx) => {
			await loadSettings(ctx);
			const snapshot = await fetchSnapshot(ctx).catch(() => undefined);
			if (!snapshot) {
				ctx.ui.notify("Could not fetch Copilot quota — is GitHub Copilot logged in?", "warning");
				return;
			}
			await record(ctx, snapshot);
			const bucket = bucketFor(snapshot, settings);
			if (!bucket || !lastState) {
				ctx.ui.notify("No metered Copilot credit bucket on this plan.", "info");
				return;
			}
			// The command shows every field regardless of the status-line toggles.
			const view = computeView(bucket, lastState, Date.now());
			ctx.ui.notify(
				formatStatus(view, {
					...DEFAULT_SETTINGS,
					showReset: true,
					numberStyle: "exact",
                    nerdFont: isNerdFont(ctx.ui.theme),
				}),
				"info",
			);
		},
	});
}
