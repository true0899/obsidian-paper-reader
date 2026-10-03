import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteReadingPositions, trimReadingPositions } from "../src/pdfview/readingPositions";
import type { ReadingPosition } from "../src/settings";

function position(updatedAt: number): ReadingPosition {
	return { page: 1, pageFraction: 0, zoomMode: "page-width", scale: 1, layoutMode: "continuous", updatedAt };
}

test("reading positions retain the latest 200 without mutating persisted input", () => {
	const input = Object.fromEntries(Array.from({ length: 220 }, (_, i) => [`${i}.pdf`, position(i)]));
	const retained = trimReadingPositions(input);
	assert.equal(Object.keys(retained).length, 200);
	assert.equal(retained["19.pdf"], undefined);
	assert.equal(retained["20.pdf"].updatedAt, 20);
	assert.equal(retained["219.pdf"].updatedAt, 219);
	assert.equal(Object.keys(input).length, 220);
	retained["219.pdf"].page = 9;
	assert.equal(input["219.pdf"].page, 1);
});

test("empty reading positions have independent dictionaries", () => {
	const first = trimReadingPositions(undefined);
	const second = trimReadingPositions(undefined);
	first["a.pdf"] = position(1);
	assert.deepEqual(second, {});
});

test("deleting a folder removes descendants but preserves similarly named paths", () => {
	const positions = { "papers/a.pdf": position(1), "papers/sub/b.pdf": position(2), "papers2/a.pdf": position(3) };
	assert.equal(deleteReadingPositions(positions, "papers"), true);
	assert.deepEqual(Object.keys(positions), ["papers2/a.pdf"]);
	assert.equal(deleteReadingPositions(positions, "missing.pdf"), false);
	assert.equal(deleteReadingPositions(positions, "papers2/a.pdf"), true);
	assert.deepEqual(positions, {});
});
