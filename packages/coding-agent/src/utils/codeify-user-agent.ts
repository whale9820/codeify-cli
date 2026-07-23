export function getCodeifyUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `codeify/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
