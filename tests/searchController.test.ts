import { test } from "node:test";
import assert from "node:assert/strict";
import { SearchController, type SearchState } from "../src/search/SearchController";

function setup(extract: (page: number) => Promise<string>) {
	const state: SearchState = { token: 0, hits: [], current: -1 };
	const navigated: number[] = [], messages: string[] = [];
	const controller = new SearchController(state, {
		renderer: { numPages: 3, getPageTextEnsured: extract } as any,
		input: () => ({ value: "needle" }) as HTMLInputElement,
		count: () => ({ setText: (text: string) => messages.push(text) }) as any,
		hasFile: () => true, pages: () => [], scale: () => 1,
		clearHighlights() {}, rememberNavigation() {},
		scrollToPage: async page => { navigated.push(page); }, domRangeForText: () => null, scrollToRect() {},
	});
	return { state, navigated, messages, controller };
}

test("search retains readable page hits after one extraction failure", async () => {
	const ctx = setup(async p => { if (p === 2) throw Error("bad page"); return "needle"; });
	await ctx.controller.run();
	assert.deepEqual(ctx.state.hits.map(h => h.page), [1, 3]);
	assert.deepEqual(ctx.navigated, [1]);
	await ctx.controller.goto(1); assert.deepEqual(ctx.navigated, [1, 3]);
});

test("document cancellation discards extraction before publishing hits", async () => {
	let finish!: (text: string) => void;
	const ctx = setup(() => new Promise(resolve => { finish = resolve; }));
	const pending = ctx.controller.run();
	ctx.state.token++; finish("needle"); await pending;
	assert.equal(ctx.state.hits.length, 0); assert.equal(ctx.navigated.length, 0);
});
