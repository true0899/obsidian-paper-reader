import { test } from "node:test";
import assert from "node:assert/strict";
import { TFile } from "obsidian";
import { getExtensionViewRegistry, getViewFile, refreshLeafHeader } from "../src/obsidian-internals";

test("extension registry adapter validates host shape and keeps the mutable original map", () => {
	const mapping = { pdf: "pdf" };
	const registry = getExtensionViewRegistry({ viewRegistry: { typeByExtension: mapping } });
	assert.equal(registry?.typeByExtension, mapping);
	assert.equal(getExtensionViewRegistry({}), null);
	assert.equal(getExtensionViewRegistry({ viewRegistry: { typeByExtension: [] } }), null);
	assert.equal(getExtensionViewRegistry({ viewRegistry: { typeByExtension: { pdf: 42 } } }), null);
});

test("file adapter requires a real host TFile", () => {
	const file = new TFile();
	assert.equal(getViewFile({ file }), file);
	assert.equal(getViewFile({ file: { path: "paper.pdf" } }), null);
	assert.equal(getViewFile(null), null);
});

test("optional header adapter keeps receiver and tolerates absent or throwing host APIs", () => {
	const leaf = { calls: 0, updateHeader() { this.calls++; } };
	refreshLeafHeader(leaf);
	assert.equal(leaf.calls, 1);
	assert.doesNotThrow(() => refreshLeafHeader({}));
	assert.doesNotThrow(() => refreshLeafHeader({ updateHeader: true }));
	assert.doesNotThrow(() => refreshLeafHeader({ updateHeader() { throw Error("changed host API"); } }));
});
