import test from "node:test";
import assert from "node:assert/strict";
import { DrawingController, type DrawingState } from "../src/pdfview/DrawingController";
import { rectanglePoints } from "../src/pdfview/InkLayer";
import type { Annotation } from "../src/storage/annotationStore";
import type { HistoryOp } from "../src/history/AnnotationHistory";
import type { RenderedPage } from "../src/pdfview/PdfRenderer";

function setup() {
	const annotations: Annotation[] = [{ id: "rectangle", type: "ink", page: 1, text: "", color: "yellow",
		rects: [{ x: 10, y: 20, width: 40, height: 30 }], ink: { width: 4, shape: "rectangle", points: rectanglePoints(10, 20, 40, 30) },
		createdAt: "", textOffset: -1, contextBefore: "", contextAfter: "" }];
	const state: DrawingState = { tool: null, liveStroke: null, liveStrokePage: 1, rectangleEdit: null };
	const history: HistoryOp[] = [], selected: Annotation[] = [], released: number[] = [];
	let identity: number | null = 1, saves = 0, redraws = 0;
	let persist = async () => true;
	const page = { pageNumber: 1, widthAtScale1: 200, heightAtScale1: 200,
		wrapper: { getBoundingClientRect: () => ({ left: 100, top: 200 }) } } as unknown as RenderedPage;
	const dependencies: ConstructorParameters<typeof DrawingController>[1] = {
		pages: () => [page], scale: () => 2, annotations: () => annotations,
		setAnnotations: next => { annotations.splice(0, annotations.length, ...next); },
		scrollElement: () => ({ setPointerCapture() {}, hasPointerCapture: () => true,
			releasePointerCapture: (id: number) => released.push(id) }) as unknown as HTMLElement,
		color: () => ({ key: "yellow", css: "#ffff00" }), width: () => 4,
		documentIdentity: () => identity, persistAndRefresh: async () => { saves++; return persist(); },
		recordHistory: op => history.push(op), setTool() {}, selectRectangle: ann => selected.push(ann),
		redrawInk: () => { redraws++; }, redrawAllInk: () => { redraws++; },
	};
	const controller = new DrawingController(state, dependencies);
	const event = (x = 120, y = 240) => ({ clientX: x, clientY: y, pointerId: 7, button: 0,
		preventDefault() {}, stopPropagation() {},
		target: { closest: () => ({ dataset: { annotationId: "rectangle", inkHandle: "move" } }) },
	}) as unknown as PointerEvent;
	return { state, controller, page, annotations, history, selected, released, event,
		setPersist: (next: typeof persist) => { persist = next; }, setIdentity: (value: number | null) => { identity = value; },
		saves: () => saves, redraws: () => redraws };
}

test("drawing coordinates use PDF scale and clamp to page bounds", () => {
	const ctx = setup();
	assert.deepEqual(ctx.controller.pointOnPage(ctx.event(5000, -50), ctx.page), { x: 200, y: 0 });
});

test("rectangle drag starts from a snapshot, moves and cancels without saving", () => {
	const ctx = setup(), before = structuredClone(ctx.annotations[0]);
	ctx.controller.pointerDown(ctx.event());
	assert.equal(ctx.state.rectangleEdit?.pointerId, 7);
	ctx.controller.pointerMove(ctx.event(160, 260));
	assert.deepEqual(ctx.annotations[0].rects, [{ x: 30, y: 30, width: 40, height: 30 }]);
	ctx.controller.cancelRectangleEdit();
	assert.deepEqual(ctx.annotations[0], before); assert.equal(ctx.state.rectangleEdit, null);
	assert.deepEqual(ctx.released, [7]); assert.equal(ctx.saves(), 0);
});

test("rectangle commit rolls back on persistence failure, then records one successful update", async () => {
	const ctx = setup(), before = structuredClone(ctx.annotations[0]);
	ctx.setPersist(async () => false);
	ctx.controller.pointerDown(ctx.event()); ctx.controller.pointerMove(ctx.event(160, 260));
	await ctx.controller.finishRectangleEdit(7, true);
	assert.deepEqual(ctx.annotations[0], before); assert.equal(ctx.history.length, 0);
	ctx.setPersist(async () => true);
	ctx.controller.pointerDown(ctx.event()); ctx.controller.pointerMove(ctx.event(160, 260));
	await ctx.controller.finishRectangleEdit(7, true);
	assert.equal(ctx.history.length, 1); assert.equal(ctx.history[0].kind, "update");
	assert.equal(ctx.state.rectangleEdit, null);
});

test("unchanged rectangle emits no persistence or history operation", async () => {
	const ctx = setup(); ctx.controller.pointerDown(ctx.event());
	await ctx.controller.finishRectangleEdit(7, true);
	assert.equal(ctx.saves(), 0); assert.equal(ctx.history.length, 0);
});

test("stroke cancellation discards preview without creating annotation", () => {
	const ctx = setup(); let discarded = false;
	ctx.state.liveStroke = { addPoint() {}, finish: () => null, discard: () => { discarded = true; } };
	ctx.controller.pointerEnd(ctx.event(), false);
	assert.equal(discarded, true); assert.equal(ctx.state.liveStroke, null);
	assert.equal(ctx.annotations.length, 1); assert.equal(ctx.saves(), 0);
});

test("failed stroke save removes draft and never creates history", async () => {
	const ctx = setup(); ctx.setPersist(async () => false);
	ctx.state.liveStroke = { addPoint() {}, finish: () => ({ width: 4, points: [0, 0, 20, 20] }), discard() {} };
	ctx.controller.pointerEnd(ctx.event(), true);
	for (let i = 0; i < 6; i++) await Promise.resolve();
	assert.equal(ctx.annotations.length, 1); assert.equal(ctx.history.length, 0);
});

test("completed rectangle opens editor only after successful save", async () => {
	const ctx = setup();
	ctx.state.liveStroke = { addPoint() {}, finish: () => ({ width: 4, shape: "rectangle", points: rectanglePoints(0, 0, 20, 20) }), discard() {} };
	ctx.controller.pointerEnd(ctx.event(), true);
	assert.equal(ctx.selected.length, 0);
	for (let i = 0; i < 6; i++) await Promise.resolve();
	assert.equal(ctx.selected.length, 1); assert.equal(ctx.history.length, 1);
});

test("late save after document switch cannot open editor or add current history", async () => {
	const ctx = setup(); let finish!: (value: boolean) => void;
	ctx.setPersist(() => new Promise(resolve => { finish = resolve; }));
	ctx.state.liveStroke = { addPoint() {}, finish: () => ({ width: 4, shape: "rectangle", points: rectanglePoints(0, 0, 20, 20) }), discard() {} };
	ctx.controller.pointerEnd(ctx.event(), true);
	ctx.setIdentity(2); finish(true);
	for (let i = 0; i < 6; i++) await Promise.resolve();
	assert.equal(ctx.selected.length, 0); assert.equal(ctx.history.length, 0);
});
