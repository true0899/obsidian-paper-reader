import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./vmLoad";

function element(tag = "div", options: any = {}): any {
	const node: any = {
		tagName: tag.toUpperCase(), cls: options.cls, text: options.text,
		style: {}, value: "", children: [], events: {}, attrs: options.attr ?? {},
		createEl(tag: string, options: any) { const child = element(tag, options); this.children.push(child); return child; },
		createDiv(options: any) { return this.createEl("div", options); },
		createSpan(options: any) { return this.createEl("span", options); },
		createSvg(tag: string, options: any) { return this.createEl(tag, options); },
		addEventListener(type: string, callback: any) { this.events[type] = callback; },
		setAttr(key: string, value: string) { this.attrs[key] = value; },
		addClass() {}, removeClass() {}, toggleClass() {}, remove() {}, focus() {},
		setText(text: string) { this.text = text; },
		appendChild() {}, getBoundingClientRect: () => ({ width: 200, height: 100 }),
	};
	return node;
}
function setup() {
	const body = element();
	const doc = { body, defaultView: { innerWidth: 800, innerHeight: 600 } };
	const { SelectionPopup } = loadTs("src/toolbar/SelectionPopup.ts", {
		"../settings": { COLOR_KEYS: ["yellow"] },
		"../pdfview/popupCache": { popupCacheKey: () => "selection" },
	});
	const saved: string[] = [];
	const popup = new SelectionPopup({
		getColors: () => ({}), getStyle: () => "highlight", getCached: () => undefined,
		setCached() {}, submitNote: async (text: string) => { saved.push(text); return true; },
	}, () => doc);
	const find = (cls: string): any => {
		const visit = (node: any): any => node.cls === cls ? node : node.children.map(visit).find(Boolean);
		return visit(body);
	};
	return { popup, saved, find, doc };
}
const anchor = { left: 10, right: 50, top: 20, bottom: 40 };
const payload = { page: 1, text: "example", rects: [], anchorRect: anchor };
const key = (options = {}) => ({ key: "Enter", preventDefault() {}, stopPropagation() {}, ...options });

test("fresh selection stays compact; saved comment supports multiline shortcut", () => {
	const { popup, saved, find } = setup();
	popup.show(payload);
	assert.equal(find("pr-popup-note-input"), undefined);
	assert.equal(find("pr-popup-actions").children[1].attrs["aria-label"], "添加批注");
	popup.showEdit({ id: "note", color: "yellow" }, 20, 20);
	const input = find("pr-popup-note-input");
	assert.equal(input.tagName, "TEXTAREA");
	input.value = "第一行\n第二行";
	input.events.keydown(key());
	input.events.keydown(key({ ctrlKey: true, isComposing: true }));
	input.events.keydown(key({ ctrlKey: true, keyCode: 229 }));
	assert.deepEqual(saved, []);
	input.events.keydown(key({ metaKey: true }));
	assert.deepEqual(saved, ["第一行\n第二行"]);
});

test("existing note can be cleared; reposition preserves draft offscreen and restores it", () => {
	const { popup, saved, find } = setup();
	popup.showEdit({ id: "note", note: "old", color: "yellow" }, 20, 20);
	const input = find("pr-popup-note-input");
	input.value = "";
	input.events.keydown(key({ ctrlKey: true }));
	assert.deepEqual(saved, [""]);
	input.value = "未保存草稿";
	const el = popup.el;
	popup.reposition({ ...anchor, top: 700, bottom: 730 });
	assert.equal(popup.el, el);
	assert.equal(el.style.visibility, "hidden");
	popup.reposition(anchor);
	assert.equal(el.style.visibility, "");
	assert.equal(input.value, "未保存草稿");
});

test("annotation menu has no range adjustment action", () => {
	const body = element();
	const { HighlightMenu } = loadTs("src/toolbar/HighlightMenu.ts", { "../settings": { COLOR_KEYS: ["yellow"] } });
	const menu = new HighlightMenu({ onRecolor() {}, onDelete() {} }, () => ({}), () => ({ body }));
	menu.show(20, 20, "yellow");
	assert.equal(menu.el.children.some((el: any) => el.text === "调整范围"), false);
	assert.equal(menu.el.children[0].tagName, "BUTTON");
});
