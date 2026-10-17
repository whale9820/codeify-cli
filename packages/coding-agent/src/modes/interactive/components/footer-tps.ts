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

/**
 * Tracks output tokens-per-second for the interactive footer.
 *
 * While streaming, chunks update an estimate at most every 500ms, and nothing
 * is shown until 300ms after the first token. On stop, the label switches to
 * the exact `output_tokens / generationTime` rate when generation lasted
 * longer than 50ms.
 */
export class FooterTpsTracker {
	private streaming = false;
	private startedAt: number | undefined;
	private firstAt: number | undefined;
	private lastDraw = Number.NEGATIVE_INFINITY;
	private estimatedTokens = 0;
	private liveLabel: string | undefined;
	private completedLabel: string | undefined;

	getLabel(): string | undefined {
		return this.streaming ? this.liveLabel : this.completedLabel;
	}

	start(now: number = Date.now()): void {
		this.streaming = true;
		this.startedAt = now;
		this.firstAt = undefined;
		this.lastDraw = Number.NEGATIVE_INFINITY;
		this.estimatedTokens = 0;
		this.liveLabel = undefined;
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
		this.liveLabel = formatTps(elapsedSec > 0 ? this.estimatedTokens / elapsedSec : 0, true);
		return true;
	}

	finish(outputTokens: number, now: number = Date.now()): boolean {
		this.streaming = false;
		this.liveLabel = undefined;
		const startedAt = this.startedAt ?? this.firstAt;
		this.firstAt = undefined;
		this.startedAt = undefined;
		this.estimatedTokens = 0;
		this.lastDraw = Number.NEGATIVE_INFINITY;

		if (startedAt === undefined || now - startedAt <= MIN_GENERATION_MS || outputTokens <= 0) {
			return false;
		}

		const elapsedSec = (now - startedAt) / 1000;
		this.completedLabel = formatTps(outputTokens / elapsedSec, false);
		return true;
	}

	cancel(): void {
		this.streaming = false;
		this.liveLabel = undefined;
		this.firstAt = undefined;
		this.startedAt = undefined;
		this.estimatedTokens = 0;
		this.lastDraw = Number.NEGATIVE_INFINITY;
	}

	reset(): void {
		this.cancel();
		this.completedLabel = undefined;
	}
}
