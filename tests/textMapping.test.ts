import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPageText } from "../src/pdfview/preciseText";
import { sameSelection, type SelectionPayload } from "../src/pdfview/selection";
import { popupCacheKey } from "../src/pdfview/popupCache";
import { findHits } from "../src/search/searchText";

test("page text preserves line boundaries and maps split spans to canonical offsets", () => {
	const mapping = buildPageText([
		{ str: "repeat", hasEOL: true }, { type: "beginMarkedContent" },
		{ str: "re" }, { str: "peat", hasEOL: true },
	]);
	assert.equal(mapping.text, "repeat\nrepeat\n");
	assert.deepEqual(mapping.items, [
		{ start: 0, end: 6, domStart: 0, domEnd: 6 },
		{ start: 7, end: 9, domStart: 6, domEnd: 8 },
		{ start: 9, end: 13, domStart: 8, domEnd: 12 },
	]);
	assert.deepEqual(findHits([mapping.text], "repeat"), [
		{ page: 1, index: 0, length: 6 }, { page: 1, index: 7, length: 6 },
	]);
});

test("repeated text and cross-page segments retain independent selection identities", () => {
	const payload = { page: 1, text: "repeat", textOffset: 0, rects: [],
		contextBefore: "", contextAfter: "", anchorRect: null } as unknown as SelectionPayload;
	const repeated = { ...payload, textOffset: 7 };
	assert.equal(sameSelection(payload, repeated), false);
	assert.notEqual(popupCacheKey(payload), popupCacheKey(repeated));
	const crossPage = { ...payload, segments: [payload, { ...repeated, page: 2 }] };
	assert.equal(sameSelection(crossPage, { ...crossPage }), true);
	assert.equal(sameSelection(crossPage, { ...crossPage, segments: [payload, { ...repeated, page: 3 }] }), false);
});

test("search covers ligatures, combining marks and line-end hyphens without losing source boundaries", () => {
	assert.deepEqual(findHits(["oﬃce"], "office"), [{ page: 1, index: 0, length: 4 }]);
	assert.deepEqual(findHits(["cafe\u0301"], "CAFÉ"), [{ page: 1, index: 0, length: 5 }]);
	assert.deepEqual(findHits(["land-\n slide"], "landslide"), [{ page: 1, index: 0, length: 12 }]);
	assert.deepEqual(findHits(["land\u00adslide"], "landslide"), [{ page: 1, index: 0, length: 10 }]);
	assert.deepEqual(findHits(["well-known"], "wellknown"), []);
});
