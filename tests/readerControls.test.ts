import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./vmLoad";
import { navigateColorButtons } from "../src/toolbar/colorKeyboard";

const { PaperReaderView } = loadTs("src/pdfview/PaperReaderView.ts");

test("modified wheel coalesces events; normal wheel retains native scrolling", async () => {
	const view = Object.create(PaperReaderView.prototype);
	let calls = 0, prevented = 0;
	Object.assign(view, { file: {}, pages: [{}], wheelZoomFactor: 1, wheelZoomTimer: null,
		flushWheelZoom: () => { calls++; }, scrollEl: { clientHeight: 500 } });
	const event = { ctrlKey: true, metaKey: false, deltaY: -30, deltaMode: 0, clientX: 200, clientY: 200,
		preventDefault: () => prevented++ };
	view.onZoomWheel({ ...event, ctrlKey: false });
	assert.equal(prevented, 0);
	for (let i = 0; i < 5; i++) view.onZoomWheel(event);
	await new Promise(r => setTimeout(r, 70));
	assert.equal(calls, 1); assert.equal(prevented, 5);
	assert.ok(view.wheelZoomFactor > 1);
});

test("gesture zoom keeps cursor's PDF point fixed and serializes rendering", async () => {
	const view = Object.create(PaperReaderView.prototype);
	const point = { x: 180, y: 240 };
	let layout: (() => void) | undefined, finish!: () => void, renders = 0;
	const scroll = { scrollLeft: 0, scrollTop: 0 };
	const page = { pageNumber: 1, wrapper: { getBoundingClientRect: () => ({
		left: 80 - scroll.scrollLeft, top: 40 - scroll.scrollTop, right: 800, bottom: 1000,
	}) } };
	Object.assign(view, { pages: [page], currentPage: 1, scale: 1, closed: false,
		wheelZoomFactor: 2, wheelZoomPoint: point, wheelZoomRunning: false, scrollEl: scroll,
		renderAll: async (callback: () => void) => { renders++; layout = callback; await new Promise<void>(r => { finish = r; }); },
		schedulePositionSave() {}, updateCurrentPageFromScroll() {} });
	const task = view.flushWheelZoom();
	await view.flushWheelZoom();
	assert.equal(renders, 1);
	layout!(); finish(); await task;
	assert.equal(view.scale, 2);
	assert.equal(80 - scroll.scrollLeft + 100 * view.scale, point.x);
	assert.equal(40 - scroll.scrollTop + 200 * view.scale, point.y);
	assert.equal(view.wheelZoomRunning, false);
});

test("closing search restores connected focus and uses reader when removed", () => {
	const view = Object.create(PaperReaderView.prototype);
	let restored = 0, fallback = 0;
	Object.assign(view, { pages: [], searchToken: 0, searchDebounce: null, closed: false,
		searchReturnFocus: { isConnected: true, focus: () => restored++ },
		scrollEl: { focus: () => fallback++ } });
	view.closeSearch(); assert.equal(restored, 1); assert.equal(fallback, 0);
	view.searchReturnFocus = { isConnected: false };
	view.closeSearch(); assert.equal(fallback, 1);
});

test("failed page retry clears only its failure and restarts the queue", () => {
	const view = Object.create(PaperReaderView.prototype);
	let retry!: () => void, removed = false, refreshed = 0;
	const error = { createSpan() {}, createEl: () => ({ addEventListener: (_: string, cb: () => void) => { retry = cb; } }),
		remove: () => { removed = true; } };
	const page = { pageNumber: 3, wrapper: { querySelector: () => null, createDiv: () => error } };
	Object.assign(view, { closed: false, pages: [page], failedPages: new Set([3, 4]),
		renderer: { releasePage() {} }, refreshPageWindow: () => { refreshed++; } });
	view.showPageRenderError(page); retry();
	assert.equal(removed, true); assert.equal(view.failedPages.has(3), false);
	assert.equal(view.failedPages.has(4), true); assert.equal(refreshed, 1);
	view.closed = true; retry(); assert.equal(refreshed, 1);
});

test("color direction keys wrap focus without committing an annotation", () => {
	let focused = -1, prevented = 0;
	const buttons = Array.from({ length: 3 }, (_, index) => ({ focus: () => { focused = index; }, parentElement: null as any }));
	for (const b of buttons) b.parentElement = { querySelectorAll: () => buttons };
	const event = (key: string, index: number) => ({ key, currentTarget: buttons[index],
		preventDefault: () => prevented++, stopPropagation() {} }) as unknown as KeyboardEvent;
	navigateColorButtons(event("ArrowLeft", 0)); assert.equal(focused, 2);
	navigateColorButtons(event("Home", 2)); assert.equal(focused, 0);
	navigateColorButtons(event("Enter", 0)); assert.equal(prevented, 2);
});
