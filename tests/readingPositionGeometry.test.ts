import { test } from "node:test";
import assert from "node:assert/strict";
import { ReadingPositionManager as Positions } from "../src/pdfview/ReadingPositionManager";

test("position capture and restore preserve page fraction across viewport sizes", () => {
 const pages = [{pageNumber:1, wrapper:{offsetTop:0, offsetHeight:1000}}, {pageNumber:2, wrapper:{offsetTop:1020, offsetHeight:1000}}];
 const view = {zoomMode:"manual", scale:2, layoutMode:"double-even"};
 const saved = Positions.capture(pages, 1070, 400, view)!;
 assert.equal(saved.page, 2); assert.equal(saved.pageFraction, .25);
 assert.equal(Positions.scrollTop(pages[1], saved.pageFraction, 600), 970);
 const valid = Positions.normalize(saved, 2); assert.equal(valid.layoutMode, "double-even");
 assert.equal(Positions.capture([], 0, 400, view), null);
});

test("malformed persisted geometry cannot create invalid layout or scroll offsets", () => {
 const saved = Positions.normalize({page:NaN, pageFraction:Infinity, scale:-2, zoomMode:"bad", layoutMode:"bad", updatedAt:0}, 9);
 assert.deepEqual(saved, {page:1, pageFraction:0, scale:1, zoomMode:"fit-width", layoutMode:"continuous", updatedAt:0});
});
