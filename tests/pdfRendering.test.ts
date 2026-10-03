import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./vmLoad";

test("detail canvas renders visible crop at owner-window DPR and releases pixels", async () => {
	const { PdfRenderer } = loadTs("src/pdfview/PdfRenderer.ts");
	const renderer = new PdfRenderer();
	const canvases: any[] = [];
	const requests: any[] = [];
	let cancelled = 0;
	const ownerDocument = { defaultView: { devicePixelRatio: 2 }, createElement() {
		const canvas: any = { style: {}, remove() { this.removed = true; } };
		canvases.push(canvas); return canvas;
	} };
	const wrapper = { ownerDocument, children: [{}, {}], insertBefore(canvas: any) { this.detail = canvas; },
		detail: null as any, getBoundingClientRect: () => ({ left: -500, top: -700, right: 1500, bottom: 2300 }),
		querySelectorAll: () => canvases, replaceChildren() {} };
	const page = { wrapper, pageNumber: 1, highlightLayer: { replaceChildren() {} },
		selectionLayer: { replaceChildren() {} }, inkLayer: { replaceChildren() {} } };
	const proxy = { getViewport: ({ scale }: any) => ({ scale }), render(options: any) {
		requests.push(options); return { promise: Promise.resolve(), cancel() { cancelled++; } };
	} };
	renderer.details.set(page, { page: proxy, scale: 4, outputScale: 1, revision: 0 });
	await renderer.updateDetail(page, { left: 0, top: 0, right: 800, bottom: 600 });
	assert.equal(canvases[0].width, 1600); assert.equal(canvases[0].height, 1200);
	assert.deepEqual(Array.from(requests[0].transform), [2, 0, 0, 2, -1000, -1400]);
	await renderer.updateDetail(page, { left: 0, top: 0, right: 800, bottom: 600 });
	assert.equal(requests.length, 1, "same viewport reuses the finished detail");
	await renderer.updateDetail(page, { left: 0, top: 3000, right: 800, bottom: 3600 });
	assert.equal(canvases[0].width, 0); assert.equal(canvases[0].height, 0);
	await renderer.updateDetail(page, { left: 0, top: 0, right: 800, bottom: 600 });
	const adopted = { ...page };
	renderer.adoptPage(page, adopted);
	assert.equal(renderer.details.has(page), false);
	assert.equal(renderer.details.has(adopted), true);
	renderer.releasePage(adopted);
	assert.equal(canvases[1].width, 0); assert.equal(renderer.details.size, 0);
	assert.equal(cancelled, 0, "finished render tasks need no cancellation");
});
