/** CJK scripts counted as one token each while streaming. */
const CJK_CHAR_REGEX =
	/[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;

const FIRST_TOKEN_DELAY_MS = 300;
const DRAW_INTERVAL_MS = 500;
const MIN_GENERATION_MS = 50;

/**
 * Rough streaming token estimate: one token per CJK character, otherwise
 * about one token per four characters.
 */
export function estimateStreamTokens(text: string): number {
	let tokens = 0;
	for (const char of text) {
		tokens += CJK_CHAR_REGEX.test(char) ? 1 : 0.25;
	}
	return tokens;
}

export function formatTps(rate: number, estimated: boolean): string {
	const value = Number.isFinite(rate) ? rate.toFixed(1) : "0.0";
	return estimated ? `~${value} tps` : `${value} tps`;
}

/** Persisted footer rate, stored in session data as a custom entry. */
export interface FooterTpsSnapshot {
	rate: number;
	estimated: boolean;
}

export const FOOTER_TPS_CUSTOM_TYPE = "footer_tps";

export function isFooterTpsSnapshot(value: unknown): value is FooterTpsSnapshot {
	if (typeof value !== "object" || value === null) return false;
	const rate: unknown = Reflect.get(value, "rate");
	const estimated: unknown = Reflect.get(value, "estimated");
	return typeof rate === "number" && Number.isFinite(rate) && rate >= 0 && typeof estimated === "boolean";
}

/**
 * Tracks output tokens-per-second for the interactive footer.
 *
 * A value is always displayed: `0.0 tps` for a new session, otherwise the last
 * displayed rate. While streaming, chunks update an estimate at most every
 * 500ms, starting 300ms after the first token; until then the previous value
 * stays visible. On stop, the value switches to the exact
 * `output_tokens / generationTime` rate when generation lasted longer than 50ms.
 */
export class FooterTpsTracker {
	private streaming = false;
	private startedAt: number | undefined;
	private firstAt: number | undefined;
	private lastDraw = Number.NEGATIVE_INFINITY;
	private estimatedTokens = 0;
	private rate = 0;
	private estimated = false;

	getLabel(): string {
		return formatTps(this.rate, this.estimated);
	}

	getSnapshot(): FooterTpsSnapshot {
		return { rate: this.rate, estimated: this.estimated };
	}

	/** Replace the displayed value, e.g. when loading a session. Ends any live stream. */
	restore(snapshot: FooterTpsSnapshot | undefined): void {
		this.cancel();
		this.rate = snapshot?.rate ?? 0;
		this.estimated = snapshot?.estimated ?? false;
	}

	start(now: number = Date.now()): void {
		this.streaming = true;
		this.startedAt = now;
		this.firstAt = undefined;
		this.lastDraw = Number.NEGATIVE_INFINITY;
		this.estimatedTokens = 0;
	}

	addChunk(delta: string, now: number = Date.now()): boolean {
		if (!this.streaming) {
			this.start(now);
		}
		if (this.firstAt === undefined) {
			this.firstAt = now;
		}
		this.estimatedTokens += estimateStreamTokens(delta);

		const firstAt = this.firstAt;
		if (!(now - firstAt > FIRST_TOKEN_DELAY_MS)) {
			return false;
		}
		if (!(now - this.lastDraw > DRAW_INTERVAL_MS)) {
			return false;
		}

		this.lastDraw = now;
		const elapsedSec = (now - firstAt) / 1000;
		this.rate = elapsedSec > 0 ? this.estimatedTokens / elapsedSec : 0;
		this.estimated = true;
		return true;
	}

	finish(outputTokens: number, now: number = Date.now()): boolean {
		this.streaming = false;
		const startedAt = this.startedAt ?? this.firstAt;
		this.firstAt = undefined;
		this.startedAt = undefined;
		this.estimatedTokens = 0;
		this.lastDraw = Number.NEGATIVE_INFINITY;

		if (startedAt === undefined || now - startedAt <= MIN_GENERATION_MS || outputTokens <= 0) {
			return false;
		}

		const elapsedSec = (now - startedAt) / 1000;
		this.rate = outputTokens / elapsedSec;
		this.estimated = false;
		return true;
	}

	/** Stop tracking the current stream, keeping the last displayed value. */
	cancel(): void {
		this.streaming = false;
		this.firstAt = undefined;
		this.startedAt = undefined;
		this.estimatedTokens = 0;
		this.lastDraw = Number.NEGATIVE_INFINITY;
	}

	reset(): void {
		this.restore(undefined);
	}
}
