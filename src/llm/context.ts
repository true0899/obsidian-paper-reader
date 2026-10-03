/** Keep complete pages where possible, then restore document reading order. */
export async function buildPageContext(
	currentPage: number,
	numPages: number,
	getPageText: (page: number) => Promise<string>,
	isCurrent: () => boolean,
	limit = 48_000,
): Promise<string> {
	const pages = new Map<number, string>();
	let size = 0;
	let truncated = false;
	const order = [currentPage];
	for (let d = 1; d < numPages; d++) {
		for (const p of [currentPage - d, currentPage + d]) {
			if (p >= 1 && p <= numPages) order.push(p);
		}
	}
	for (const page of order) {
		if (!isCurrent()) throw new Error("Document changed");
		const text = await getPageText(page);
		if (!isCurrent()) throw new Error("Document changed");
		if (!text) continue;
		const block = `[page ${page}]\n${text}\n`;
		if (size + block.length > limit) {
			truncated = true;
			if (pages.size === 0) pages.set(page, block.slice(0, limit));
			break;
		}
		pages.set(page, block);
		size += block.length;
	}
	return [...pages].sort(([a], [b]) => a - b).map(([, text]) => text).join("") +
		(truncated ? "\n[context truncated: only the pages above are provided]\n" : "");
}
