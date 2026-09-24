import type { TextCitation } from "../types.ts";

export interface CitationSource {
	url: string;
	title?: string;
}

const SOURCE_ID = /^turn\d+[A-Za-z]+\d+$/;
const LINE_LOCATOR = /^L\d+(?:-L\d+)?$/;
const PAREN_CITATION = /\(\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)\)/g;

interface ContentBlock {
	type?: string;
	text?: string;
	citations?: TextCitation[];
	name?: string;
	id?: string;
	toolUseId?: string;
	content?: unknown;
}

function isBlock(value: unknown): value is ContentBlock {
	return Boolean(value) && typeof value === "object";
}

function readSources(content: unknown): CitationSource[] {
	if (!Array.isArray(content)) return [];
	const sources: CitationSource[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const record = item as { url?: unknown; title?: unknown };
		if (typeof record.url !== "string" || record.url.length === 0) continue;
		const title = typeof record.title === "string" ? record.title : undefined;
		sources.push(title ? { url: record.url, title } : { url: record.url });
	}
	return sources;
}

function parentheticalCitations(text: string): CitationSource[] {
	const sources: CitationSource[] = [];
	for (const match of text.matchAll(PAREN_CITATION)) {
		const title = match[1]?.trim();
		const url = match[2];
		if (!url) continue;
		sources.push(title ? { url, title } : { url });
	}
	return sources;
}

function markerRanges(text: string): Array<{ start: number; end: number; body: string }> {
	const ranges = [];
	for (const match of text.matchAll(/\uE200cite\uE202([\s\S]*?)\uE201/g)) {
		const start = match.index ?? 0;
		ranges.push({ start, end: start + match[0].length, body: match[1] ?? "" });
	}
	return ranges;
}

function overlaps(start: number, end: number, citation: TextCitation): boolean {
	return citation.endIndex > start && citation.startIndex < end;
}

function parseRefs(body: string): string[] {
	const parts = body
		.split("\uE202")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	if (parts.length > 0 && LINE_LOCATOR.test(parts[parts.length - 1] ?? "")) parts.pop();
	return parts.filter((part) => SOURCE_ID.test(part));
}

function recordExplicitCitations(
	text: string,
	citations: readonly TextCitation[] | undefined,
	sources: Map<string, CitationSource>,
): void {
	if (!citations || citations.length === 0) return;
	for (const marker of markerRanges(text)) {
		const refs = parseRefs(marker.body);
		const overlapping = citations.filter((citation) => overlaps(marker.start, marker.end, citation));
		for (let index = 0; index < refs.length; index++) {
			const citation = overlapping[index];
			const ref = refs[index];
			if (!citation?.url || !ref) continue;
			sources.set(ref, { url: citation.url, title: citation.title });
		}
	}
}

function citationsOutsideMarkers(text: string, citations: readonly TextCitation[]): CitationSource[] {
	const markers = markerRanges(text);
	const sources: CitationSource[] = [];
	for (const citation of citations) {
		if (!citation.url) continue;
		if (markers.some((marker) => overlaps(marker.start, marker.end, citation))) continue;
		sources.push({ url: citation.url, title: citation.title });
	}
	return sources;
}

function contentBlocks(content: unknown): ContentBlock[] {
	if (!Array.isArray(content)) return [];
	return content.filter(isBlock);
}

export function buildCitationSources(
	messages: readonly { role?: string; content?: unknown }[],
): Map<string, CitationSource> {
	const sources = new Map<string, CitationSource>();
	let turn = 0;
	const explicit: Array<{ text: string; citations?: TextCitation[] }> = [];

	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const blocks = contentBlocks(message.content);
		const resultsById = new Map<string, CitationSource[]>();
		for (const block of blocks) {
			if (block.type !== "serverToolResult" || typeof block.toolUseId !== "string") continue;
			const parsed = readSources(block.content);
			if (parsed.length > 0) resultsById.set(block.toolUseId, parsed);
		}

		const searches: CitationSource[][] = [];
		const texts: string[] = [];
		const looseCitations: TextCitation[] = [];
		for (const block of blocks) {
			if (block.type === "text" && typeof block.text === "string") {
				texts.push(block.text);
				if (block.citations) looseCitations.push(...block.citations);
				explicit.push({ text: block.text, citations: block.citations });
			}
			if (block.type === "serverToolUse" && block.name === "web_search") {
				const listed = typeof block.id === "string" ? resultsById.get(block.id) : undefined;
				searches.push(listed ?? []);
			}
		}

		const rendered = parentheticalCitations(texts.join("\n"));
		const ordered = rendered.length > 0 ? rendered : citationsOutsideMarkers(texts.join("\n"), looseCitations);
		if (searches.length === 1) {
			const listed = searches[0] ?? [];
			listed.forEach((source, index) => {
				const key = `turn${turn}search${index}`;
				if (!sources.has(key)) sources.set(key, source);
			});
			ordered.forEach((source, index) => {
				const key = `turn${turn}search${index}`;
				if (!sources.has(key)) sources.set(key, source);
			});
		} else {
			searches.forEach((listed, offset) => {
				listed.forEach((source, index) => {
					const key = `turn${turn + offset}search${index}`;
					if (!sources.has(key)) sources.set(key, source);
				});
			});
		}
		turn += searches.length;
	}

	for (const block of explicit) recordExplicitCitations(block.text, block.citations, sources);
	return sources;
}

function codeRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	for (const match of text.matchAll(/```[\s\S]*?```|`[^`\n]+`/g)) {
		const start = match.index ?? 0;
		ranges.push([start, start + match[0].length]);
	}
	const fences = [...text.matchAll(/```/g)];
	if (fences.length % 2 === 1) {
		const start = fences[fences.length - 1]?.index ?? 0;
		ranges.push([start, text.length]);
	}
	return ranges;
}

function insideRanges(ranges: Array<[number, number]>, index: number): boolean {
	return ranges.some(([start, end]) => index >= start && index < end);
}

function citationLabel(source: CitationSource): string {
	try {
		const host = new URL(source.url).hostname.replace(/^www\./, "");
		if (host) return host;
	} catch {
		// Keep the title or raw URL when the citation target is not an absolute URL.
	}
	const title = source.title?.trim();
	return title && title.length > 0 ? title : source.url;
}

function escapeLabel(label: string): string {
	return label.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function formatCitation(resolved: readonly CitationSource[]): string {
	if (resolved.length === 0) return "";
	const links = resolved.map(
		(source) => `[${escapeLabel(citationLabel(source))}](${source.url.replaceAll(")", "%29")})`,
	);
	return `(${links.join(", ")})`;
}

function resolveCite(
	body: string,
	start: number,
	end: number,
	sources: ReadonlyMap<string, CitationSource>,
	citations: readonly TextCitation[] | undefined,
): string {
	const refs = parseRefs(body);
	const overlapping = (citations ?? [])
		.filter((citation) => overlaps(start, end, citation))
		.sort((left, right) => left.startIndex - right.startIndex);
	const resolved: CitationSource[] = [];
	for (let index = 0; index < refs.length; index++) {
		const citation = overlapping[index];
		const ref = refs[index];
		if (citation?.url) {
			resolved.push({ url: citation.url, title: citation.title });
			continue;
		}
		const known = ref ? sources.get(ref) : undefined;
		if (known) resolved.push(known);
	}
	return formatCitation(resolved);
}

function consumeMarker(text: string, start: number): number {
	let index = start + 1;
	while (index < text.length) {
		const char = text[index] ?? "";
		if (char === "\uE201") return index + 1;
		if (char === "\uE202" || char === "\uE200" || /[A-Za-z0-9_-]/.test(char)) {
			index++;
			continue;
		}
		break;
	}
	return index;
}

export function renderInlineCitations(
	text: string,
	sources: ReadonlyMap<string, CitationSource> = new Map(),
	citations?: readonly TextCitation[],
): string {
	if (!text.includes("\uE200") && !text.includes("\uE203") && !text.includes("\uE204")) return text;

	const blocked = codeRanges(text);
	let rendered = "";
	let last = 0;
	for (const match of text.matchAll(/\uE200cite\uE202([\s\S]*?)\uE201/g)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		if (insideRanges(blocked, start)) continue;
		rendered += text.slice(last, start);
		rendered += resolveCite(match[1] ?? "", start, end, sources, citations);
		last = end;
	}
	rendered += text.slice(last);

	const ranges = codeRanges(rendered);
	let cleaned = "";
	for (let index = 0; index < rendered.length; ) {
		if (insideRanges(ranges, index)) {
			const range = ranges.find(([start, end]) => index >= start && index < end);
			const end = range?.[1] ?? index + 1;
			cleaned += rendered.slice(index, end);
			index = end;
			continue;
		}
		const char = rendered[index];
		if (char === "\uE203" || char === "\uE204") {
			index++;
			continue;
		}
		if (char === "\uE200") {
			const nextCode = ranges.find(([start]) => start > index)?.[0] ?? rendered.length;
			const close = rendered.indexOf("\uE201", index);
			index = close !== -1 && close < nextCode ? close + 1 : consumeMarker(rendered, index);
			continue;
		}
		cleaned += char;
		index++;
	}
	return cleaned;
}
