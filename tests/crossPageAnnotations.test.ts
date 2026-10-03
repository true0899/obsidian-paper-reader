import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./vmLoad";
import { annotationFromPayload } from "../src/storage/annotationStore";
import { AnnotationHistory, cloneAnnotation } from "../src/history/AnnotationHistory";

const { PaperReaderView } = loadTs("src/pdfview/PaperReaderView.ts", {
	"../storage/annotationStore": { annotationFromPayload },
	"../history/AnnotationHistory": { cloneAnnotation },
});
const segment = (page: number, text: string) => ({ page, text, textOffset: page * 10,
	rects: [{ x: 20, y: 30, width: 40, height: 10 }], contextBefore: "before", contextAfter: "after" });
const payload = { ...segment(1, "first"), text: "first\nsecond", segments: [segment(1, "first"), segment(2, "second")] };

function view() {
	const v = Object.create(PaperReaderView.prototype);
	Object.assign(v, { data: { annotations: [] }, file: { path: "paper.pdf" }, popup: { payloadSnapshot: payload, hide() {} },
		pendingNoteIds: [], editingNoteId: null, popupColor: "yellow", popupStyle: "highlight",
		selectionActions: { refreshIndicator() {} }, clearSelection() {}, persistAndRefresh: async () => true });
	v.history = new AnnotationHistory((op, direction) => v.applyHistoryOp(op, direction), () => {});
	return v;
}

test("cross-page save retains per-page text and geometry; undo and redo are one atomic action", async () => {
	const v = view();
	await v.commitHighlight("yellow", payload);
	assert.deepEqual(Array.from(v.data.annotations, (a: any) => [a.page, a.text]), [[1, "first"], [2, "second"]]);
	assert.equal(v.data.annotations[0].groupId, v.data.annotations[1].groupId);
	await v.history.undo(); assert.equal(v.data.annotations.length, 0);
	await v.history.redo(); assert.equal(v.data.annotations.length, 2);
	const snapshot = structuredClone(v.data.annotations);
	v.persistAndRefresh = async () => false;
	await v.commitHighlight("red", payload);
	assert.equal(JSON.stringify(v.data.annotations), JSON.stringify(snapshot), "failed save restores the whole batch");
});

test("failed cross-page note retry saves one batch and records an add, including empty edits", async () => {
	const v = view();
	v.persistAndRefresh = async () => false;
	assert.equal(await v.submitNote("draft"), false);
	assert.equal(v.data.annotations.length, 2);
	assert.equal(v.history.canUndo, false);
	v.persistAndRefresh = async () => true;
	assert.equal(await v.submitNote("line one\nline two"), true);
	assert.equal(v.data.annotations.length, 2);
	assert.ok(v.data.annotations.every((a: any) => a.note === "line one\nline two"));
	await v.history.undo(); assert.equal(v.data.annotations.length, 0);
	await v.history.redo();
	v.editingNoteId = v.data.annotations[0].id;
	await v.submitNote("");
	assert.ok(v.data.annotations.every((a: any) => a.note === ""));
	await v.history.undo();
	assert.ok(v.data.annotations.every((a: any) => a.note === "line one\nline two"));
});
