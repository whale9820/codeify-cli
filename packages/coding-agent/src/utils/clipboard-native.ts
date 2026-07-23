import { createRequire } from "module";
import { dirname, join } from "path";
import { pathToFileURL } from "url";

export type ClipboardModule = {
	getText: () => Promise<string>;
	setText: (text: string) => Promise<void>;
	hasImage: () => boolean;
	getImageBinary: () => Promise<Array<number>>;
};

type ClipboardRequire = (id: string) => unknown;

const moduleRequire = createRequire(import.meta.url);
const executableDirRequire = createRequire(pathToFileURL(join(dirname(process.execPath), "package.json")).href);

export function loadClipboardNative(
	requires: readonly ClipboardRequire[] = [moduleRequire, executableDirRequire],
): ClipboardModule | null {
	for (const requireClipboard of requires) {
		try {
			return requireClipboard("@mariozechner/clipboard") as ClipboardModule;
		} catch {
			// Try the next resolution root.
		}
	}
	return null;
}

export function createClipboardNativeLoader(
	load: () => ClipboardModule | null = () => loadClipboardNative(),
	isAvailable: () => boolean = () =>
		!process.env.TERMUX_VERSION &&
		(process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)),
): () => ClipboardModule | null {
	let clipboard: ClipboardModule | null | undefined;
	return () => {
		if (clipboard === undefined) {
			clipboard = isAvailable() ? load() : null;
		}
		return clipboard;
	};
}

export const getClipboardNative = createClipboardNativeLoader();
