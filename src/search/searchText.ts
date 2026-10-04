/// <reference lib="es2022.intl" />
export interface SearchHit {
	page: number;
	/** UTF-16 offset in extracted page text. */
	index: number;
	length: number;
}

/** Unicode normalization with original UTF-16 boundaries for every output character. */
export function normalizeWithMap(text: string): { norm: string; map: number[]; ends: number[] } {
	const map: number[] = [], ends: number[] = [];
	let norm = "", inWs = false;
	const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	let skipUntil = 0;
	for (const { segment, index } of segmenter.segment(text)) {
		if (index < skipUntil || segment === "\u00ad") continue;
		// PDF line-end hyphenation is a layout break, not part of the searched word.
		if (/[-\u2010]/.test(segment) && /\p{L}$/u.test(text.slice(0, index))) {
			const continuation = /^[-\u2010][ \t]*\r?\n[ \t]*(?=\p{L})/u.exec(text.slice(index));
			if (continuation) { skipUntil = index + continuation[0].length; continue; }
		}
		if (/^\s+$/u.test(segment)) {
			if (!inWs && norm.length > 0) { norm += " "; map.push(index); ends.push(index + segment.length); }
			else if (inWs && ends.length) ends[ends.length - 1] = index + segment.length;
			inWs = true;
		} else {
			const normalized = segment.normalize("NFKC").toLowerCase();
			norm += normalized;
			for (let i = 0; i < normalized.length; i++) { map.push(index); ends.push(index + segment.length); }
			inWs = false;
		}
	}
	return { norm, map, ends };
}

export function normalizeQuery(query: string): string {
	return normalizeWithMap(query.trim()).norm;
}

/** Match a cached page index without normalizing the page again for every query. */
export function findPageHits(
	{ norm, map, ends }: ReturnType<typeof normalizeWithMap>, q: string, page: number
): SearchHit[] {
	if (!q) return [];
	const hits: SearchHit[] = [];
	let from = 0;
	for (;;) {
		const idx = norm.indexOf(q, from);
		if (idx < 0) break;
		const origStart = map[idx];
		const origEnd = ends[idx + q.length - 1];
		hits.push({ page, index: origStart, length: origEnd - origStart });
		from = idx + 1;
	}
	return hits;
}

/**
 * Find all hits of query inside each page's extracted text.
 * pageTexts[i] corresponds to page i + 1; undefined entries are skipped.
 */
export function findHits(
	pageTexts: (string | undefined)[],
	query: string
): SearchHit[] {
	const q = normalizeQuery(query);
	if (!q) return [];
	const hits: SearchHit[] = [];
	for (let p = 0; p < pageTexts.length; p++) {
		const text = pageTexts[p];
		if (!text) continue;
		for (const hit of findPageHits(normalizeWithMap(text), q, p + 1)) hits.push(hit);
	}
	return hits;
}
