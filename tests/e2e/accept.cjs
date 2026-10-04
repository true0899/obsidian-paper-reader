// Playwright acceptance: note add -> visible -> edit -> reload restore ->
// translate (mock SSE) -> insert notes.md
const { chromium } = require("playwright");

let failures = 0;
function check(label, cond, detail = "") {
	if (cond) console.log(`  PASS ${label}`);
	else {
		console.log(`  FAIL ${label} ${detail}`);
		failures++;
	}
}

(async () => {
	const browser = await chromium.launch();
	const page = await browser.newPage({ deviceScaleFactor: 2 });
	page.on("pageerror", (e) => { failures++; console.log("[pageerror]", e.message); });

	await page.goto(process.env.PR_TEST_URL || "http://127.0.0.1:8931/harness.html");
	if (process.env.PR_E2E_CONTROLS_ONLY) {
		await require("./readerControls.cjs")(page, check);
		await page.evaluate(() => window.__h.closeReader());
		const english = await browser.newPage();
	await english.addInitScript(() => { globalThis.__testLanguage = "en"; });
	await english.goto(process.env.PR_TEST_URL);
	await english.waitForFunction(() => !!window.__h);
	await english.evaluate(() => window.__h.openReader());
	const englishUi = await english.evaluate(() => {
		const labels = [...window.__h.reader.headerEl.querySelectorAll("button")].map(b => b.getAttribute("aria-label") || b.textContent);
		return { zoom: labels.includes("Zoom out"), select: labels.includes("Select text"), comment: labels.includes("Comment"), chinese: labels.some(label => /[\u3400-\u9fff]/.test(label || "")) };
	});
	check("英文界面使用宿主语言", englishUi.zoom && englishUi.select && englishUi.comment && !englishUi.chinese, JSON.stringify(englishUi));
	await english.close();
	await browser.close();
		process.exitCode = failures ? 1 : 0;
		return;
	}
	// Load the actual three-file production bundle, then use its embedded worker.
	const bundledWorker = await page.evaluate(async () => {
		const urls = [];
		const original = URL.createObjectURL;
		URL.createObjectURL = function(blob) { const url = original.call(URL, blob); urls.push(url); return url; };
		class Plugin {
			constructor() { this.app = { vault: { on() {} }, workspace: { on() {} } }; }
			loadData() { return Promise.resolve(null); }
			register() {} registerView() {} registerEvent() {} addRibbonIcon() {}
			addCommand() {} addSettingTab() {} registerObsidianProtocolHandler() {}
		}
		const obsidian = { Plugin, PluginSettingTab: class {}, ItemView: class {}, Notice: class {}, Menu: class {} };
		const module = { exports: {} };
		try {
			const code = await (await fetch('/main.js')).text();
			new Function('require', 'module', 'exports', code)(name => {
				if(name !== 'obsidian') throw Error('Unexpected external dependency: '+name);
				return obsidian;
			}, module, module.exports);
			await new module.exports.default().onload();
			if (!urls.length) throw Error('Production bundle created no embedded worker');
			window.__h.useWorker(urls[0]);
			return urls[0].startsWith('blob:');
		} finally { URL.createObjectURL = original; }
	});
	check('三文件发布包加载并创建内嵌 Worker', bundledWorker);
	const numPages = await page.evaluate(() => window.__h.loadPdf());
	console.log(`PDF loaded, ${numPages} pages`);
	const precise = await page.evaluate(() => {
		const payload = window.__h.selectText("LandslideAgent", 0, 9);
		const range = window.getSelection().getRangeAt(0).cloneRange();
		range.collapse(false);
		const bounds = document.querySelector(".pr-page").getBoundingClientRect();
		return { text: payload.text, right: range.getClientRects()[0].left - bounds.left };
	});
	// Times-Roman PDF advances for “Landslide” total 3944/1000 em, at 20 pt.
	check("逐字选区端点对应 PDF 字宽", precise.text === "Landslide" && Math.abs(precise.right - (40 + 78.88) * 1.5) < 0.5, JSON.stringify(precise));
	const splitWord = await page.evaluate(() => window.__h.splitWordHighlights());
	check("单词分两次高亮：直角、边界连续且标注独立", Math.abs(splitWord.gap) < 0.05 && splitWord.radius === "0px" && splitWord.noteRadius === "0px" && splitWord.separateAnnotations, JSON.stringify(splitWord));
	const preview = await page.evaluate(() => window.__h.previewTitleSelection());
	check("多行实时选区可见且不会叠色", preview.bands === 3 && !preview.overlaps && preview.nativeHidden && preview.fillVisible && preview.text.includes("LandslideAgent"), JSON.stringify(preview));
	await page.evaluate(() => window.__h.clearSelectionPreview());

	// 1) select one line of the title and add a note
	const payloadJson = await page.evaluate(() => {
		const p = window.__h.selectText("LandslideAgent", 0, 20);
		return { text: p.text, rects: p.rects.length, page: p.page };
	});
	check("选区生成 payload（单行）", payloadJson.rects === 1, JSON.stringify(payloadJson));

	const step1 = await page.evaluate(async () => {
		const p = window.__h.selectText("LandslideAgent", 0, 20);
		const id = await window.__h.addNote(p, "这是测试批注");
		return { id, ...window.__h.renderedNoteInfo() };
	});
	check("添加批注后页面可见（淡色矩形+图标）", step1.rects >= 1 && step1.icons === 1, JSON.stringify(step1));

	// 2) edit the note
	await page.evaluate(async (id) => window.__h.editNote(id, "编辑后的批注"), step1.id);
	const afterEdit = await page.evaluate(() => ({
		...window.__h.renderedNoteInfo(),
		saved: window.__h.adapter.files.get("05-论文/paper.annotations.json"),
	}));
	check("编辑批注后仍可见且已保存", afterEdit.rects >= 1 && afterEdit.saved.includes("编辑后的批注"));

	// 3) reload from disk (simulate close/reopen)
	const restored = await page.evaluate(() => window.__h.reloadFromDisk());
	check(
		"重开后批注从 JSON 恢复且渲染",
		restored.annotations >= 1 && restored.note === "编辑后的批注"
	);
	const afterReload = await page.evaluate(() => window.__h.renderedNoteInfo());
	check("重开后批注矩形/图标仍渲染", afterReload.rects >= 1 && afterReload.icons === 1);

	let aiDialogs = 0;
	const unexpectedDialog = async dialog => { aiDialogs++; await dialog.dismiss(); };
	page.on("dialog", unexpectedDialog);
	// 4) translate with mocked SSE
	const tr = await page.evaluate(async () => {
		const p = window.__h.selectText("Domain-Rule-Augmented", 0, 15);
		const out = await window.__h.translate(p);
		return { out, anns: window.__h.data.annotations.length };
	});
	check("翻译流式返回 mock 译文", tr.out === "滑坡智能体", tr.out);
	page.off("dialog", unexpectedDialog);
	check("首次翻译直接执行，不弹确认", aiDialogs === 0);
	check("翻译记录为 translation 标注", tr.anns >= 2);

	// 5) insert into notes.md
	const notes = await page.evaluate(async () => {
		const p = window.__h.selectText("Domain-Rule-Augmented", 0, 15);
		return window.__h.insertNotes(p, "滑坡智能体");
	});
	console.log("---- notes.md ----\n" + notes + "\n------------------");
	check("notes.md 含 frontmatter", notes.includes('pdf: "[[paper.pdf]]"'));
	check("notes.md 含引用原文", notes.includes("> A Domain-Rule-A"));
	check("notes.md 含译文与页码", notes.includes("滑坡智能体") && notes.includes("p.1"));

	// Whole middle spans must not produce both element and text underlines.
	for (const scale of [0.75, 1.5, 3, 5]) {
		for (const reverse of [false, true]) {
			const count = await page.evaluate(({ scale, reverse }) => window.__h.underlineTitle(scale, reverse), { scale, reverse });
			check(`三行标题各一条下划线 scale=${scale} reverse=${reverse}`, count === 3, `lines=${count}`);
			if (!reverse) {
				const b = await page.evaluate(() => {
					window.__h.selectText("LandslideAgent", 0, 9);
					const r = window.getSelection().getRangeAt(0).getBoundingClientRect();
					return { x: r.x, y: r.y, right: r.right, height: r.height,
						pageLeft: document.querySelector(".pr-page").getBoundingClientRect().left };
				});
				check(`缩放后逐字端点 scale=${scale}`, Math.abs(b.right - b.pageLeft - 118.88 * scale) < 0.5);
				await page.evaluate(() => window.getSelection().removeAllRanges());
				await page.mouse.move(b.x + 0.1, b.y + b.height / 2);
				await page.mouse.down();
				await page.mouse.move(b.right, b.y + b.height / 2, { steps: 12 });
				await page.mouse.up();
				const text = await page.evaluate(() => window.getSelection().toString());
				check(`鼠标按字形边界拖选 scale=${scale}`, text === "Landslide", text);
				if (scale === 1.5) {
					await page.mouse.dblclick(b.x + 25, b.y + b.height / 2);
					const word = await page.evaluate(() => window.getSelection().toString());
					check("双击仍选择完整单词", word === "LandslideAgent", word);
				}
			}
		}
	}

	// Existing annotations must not intercept a new native text selection.
	await page.evaluate(() => window.__h.underlineTitle(1.5, false));
	const titleBox = await page.evaluate(() => {
		window.__h.selectText("LandslideAgent", 0, 35);
		const b = window.getSelection().getRangeAt(0).getBoundingClientRect();
		return { x: b.x, y: b.y, width: b.width, height: b.height };
	});
	await page.evaluate(() => window.getSelection()?.removeAllRanges());
	await page.mouse.move(titleBox.x + 10, titleBox.y + titleBox.height / 2);
	await page.mouse.down();
	await page.mouse.move(titleBox.x + titleBox.width / 2, titleBox.y + titleBox.height / 2, { steps: 8 });
	await page.mouse.up();
	const reselected = await page.evaluate(({ x, y }) => ({
		text: window.getSelection()?.toString() ?? "",
		hit: document.elementFromPoint(x, y)?.className ?? "",
		pointer: getComputedStyle(document.querySelector(".pr-highlight-rect")).pointerEvents,
	}), { x: titleBox.x + 10, y: titleBox.y + titleBox.height / 2 });
	check("已有下划线上仍可用鼠标重新选文", reselected.text.length > 0, JSON.stringify(reselected));
	await page.evaluate(() => window.getSelection()?.removeAllRanges());
	const underlineBox = await page.locator(".pr-highlight-rect").first().boundingBox();
	await page.mouse.click(underlineBox.x + underlineBox.width / 2, underlineBox.y + underlineBox.height / 2);
	const clickedHighlight = await page.evaluate(() => window.__h.lastHighlightClick());
	check("单击已有下划线仍能命中标注", !!clickedHighlight);

	// 6) pen stroke: draw -> persisted -> reload restores -> undo/redo
	const stroke = await page.evaluate(() => window.__h.drawStroke());
	check("画笔一笔生成一条笔迹路径", stroke.paths === 1, JSON.stringify(stroke));
	const inkRestored = await page.evaluate(async () => {
		await window.__h.reloadFromDisk();
		return window.__h.inkInfo();
	});
	check("重开后笔迹恢复", inkRestored.anns === 1 && inkRestored.paths === 1, JSON.stringify(inkRestored));
	const rectangle = await page.evaluate(() => window.__h.drawRectangle());
	check("矩形框生成闭合四边路径", rectangle.points.length === 10 &&
		rectangle.points[0] === rectangle.points.at(-2) && rectangle.points[1] === rectangle.points.at(-1) &&
		rectangle.paths === 0 && rectangle.shape === "rectangle" &&
		rectangle.handles === 8 && rectangle.selection === 1, JSON.stringify(rectangle));

	const undoRedo = await page.evaluate(async () => {
		const r = {};
		await window.__h.history.undo();
		r.undoInfo = window.__h.inkInfo();
		await window.__h.history.redo();
		r.redoInfo = window.__h.inkInfo();
		return r;
	});
	check("撤销删除笔迹 / 重做恢复", undoRedo.undoInfo.anns === 0 && undoRedo.undoInfo.paths === 0 && undoRedo.redoInfo.anns === 1, JSON.stringify(undoRedo));

	const delUndo = await page.evaluate(async (noteId) => {
		const r = {};
		const before = window.__h.data.annotations.length;
		await window.__h.deleteAnnotation(noteId);
		r.afterDelete = window.__h.data.annotations.length;
		r.before = before;
		await window.__h.history.undo();
		r.afterUndo = window.__h.data.annotations.length;
		return r;
	}, step1.id);
	check("删除批注→撤销恢复", delUndo.afterDelete === delUndo.before - 1 && delUndo.afterUndo === delUndo.before, JSON.stringify(delUndo));

	// 7) full-text search incl. unvisited pages
	const search = await page.evaluate(async () => ({
		hit: await window.__h.searchAll("LandslideAgent"),
		miss: await window.__h.searchAll("zzzz-not-exist"),
	}));
	check("搜索命中且定位页码", search.hit.total >= 1 && search.hit.firstPage === 1, JSON.stringify(search.hit));
	check("无结果搜索返回 0", search.miss.total === 0);
	const uiRegression = await page.evaluate(() => window.__h.uiRegressionInfo());
	check("搜索栏隐藏规则可关闭搜索栏", uiRegression.searchHidden, JSON.stringify(uiRegression));
	check("删除批注按钮内容不溢出遮挡相邻控件", uiRegression.deleteFits, JSON.stringify(uiRegression));
	check("矩形编辑器显示线宽且隐藏文本样式", uiRegression.rectangleWidths === 3 && uiRegression.rectangleTextStyles === 0, JSON.stringify(uiRegression));

	// 8) annotation list reflects current data
	const listInfo = await page.evaluate(() => ({
		...window.__h.buildAnnotationList(),
		anns: window.__h.data.annotations.length,
	}));
	check("标注列表条目数与标注一致", listInfo.items === listInfo.anns, JSON.stringify(listInfo));

	// 9) duplicate notes export is skipped (content-hash dedupe)
	const dup = await page.evaluate(async () => {
		const p = window.__h.selectText("Domain-Rule-Augmented", 0, 15);
		const first = await window.__h.insertNotes(p, "滑坡智能体");
		const second = await window.__h.insertNotes(p, "滑坡智能体");
		return { same: first === second, hasLink: second.includes("obsidian://paper-reader?file=") };
	});
	check("重复导出被跳过且含回链", dup.same && dup.hasLink, JSON.stringify(dup));

	const inkPreview = await page.evaluate(() => {
		const ann = { ink: { width: 2, points: [10, 20, 30, 40] } };
		const svg = window.__inkPreview(ann, 120);
		const malicious = window.__inkPreview({ ink: { width: '2" onload="alert(1)', points: [0, 0] } });
		return {
			path: svg.querySelector("path").getAttribute("d"),
			size: svg.getAttribute("width"),
			exported: new DOMParser().parseFromString(svg.outerHTML, "image/svg+xml").querySelector("path") !== null,
			rejected: malicious === null,
		};
	});
	check("画笔预览与 SVG 导出保留路径、尺寸并拒绝无效数据", inkPreview.path === "M 4 4 L 24 24" && inkPreview.size === "120" && inkPreview.exported && inkPreview.rejected, JSON.stringify(inkPreview));

	// Real reader orchestration (host APIs stubbed), not just the renderer module.
	const window30 = await page.evaluate(() => window.__h.openReader());
	check("30 页只渲染视口附近页面", window30.pages === 30 && window30.mounted.length <= 8 && window30.mounted.length > 0 && !window30.failures.length, JSON.stringify(window30));

	const toolbar = await page.evaluate(() => {
		const v = window.__h.reader;
		const rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, middle: (r.left + r.right) / 2 }; };
		return { left: rect(v.headerEl.querySelector(".pr-header-start")), center: rect(v.headerEl.querySelector(".pr-header-center")), right: rect(v.headerEl.querySelector(".pr-header-end")), header: rect(v.headerEl), label: v.pageInputEl.value, count: v.pageTotalEl.textContent };
	});
	check("工具栏采用左导航、中间批注、右操作布局", toolbar.left.right < toolbar.center.left && toolbar.center.right < toolbar.right.left && Math.abs(toolbar.center.middle - toolbar.header.middle) < 2 && toolbar.label === "i" && toolbar.count === "1 / 30", JSON.stringify(toolbar));
	await page.getByRole("button", { name: "下一页", exact: true }).click();
	await page.waitForFunction(() => window.__h.reader.currentPage === 2);
	await page.getByRole("textbox", { name: "页码", exact: true }).fill("iii");
	await page.getByRole("textbox", { name: "页码", exact: true }).press("Enter");
	await page.waitForFunction(() => window.__h.reader.currentPage === 3);
	check("页码框按 PDF 标签跳转并显示实际页数", await page.evaluate(() => window.__h.reader.pageInputEl.value === "iii" && window.__h.reader.pageTotalEl.textContent === "3 / 30"));
	await page.getByRole("textbox", { name: "页码", exact: true }).fill("1");
	await page.getByRole("textbox", { name: "页码", exact: true }).press("Enter");
	await page.waitForFunction(() => window.__h.reader.currentPage === 1);
	await page.getByRole("button", { name: "更多选区操作", exact: true }).click();
	await page.waitForFunction(() => !!window.__h.reader.headerEl.querySelector(".pr-actions-extra").style.top);
	const moreMenu = await page.evaluate(() => {
		const menu = window.__h.reader.headerEl.querySelector(".pr-actions-extra"), box = menu.getBoundingClientRect();
		return { open: menu.parentElement.open, visible: getComputedStyle(menu).display, right: box.right, bottom: box.bottom, width: innerWidth, height: innerHeight, text: menu.textContent, hit: menu.contains(document.elementFromPoint(box.left + 12, box.top + 12)) };
	});
	check("更多菜单保留复制与 AI 操作且位于可视区域", moreMenu.open && moreMenu.hit && moreMenu.right <= moreMenu.width && moreMenu.bottom <= moreMenu.height && moreMenu.text.includes("AI 问答") && moreMenu.text.includes("复制"), JSON.stringify(moreMenu));
	await page.getByRole("button", { name: "更多选区操作", exact: true }).press("Escape");
	await page.getByRole("button", { name: "搜索文档 (Cmd/Ctrl+F)", exact: true }).click();
	check("右侧搜索按钮打开搜索栏", await page.evaluate(() => !window.__h.reader.searchBarEl.classList.contains("pr-hidden")));
	await page.evaluate(() => window.__h.reader.closeSearch());
	await page.screenshot({ path: "/tmp/paper-reader-toolbar.png" });
	const pdfLinks = await page.evaluate(() => {
		const v = window.__h.reader;
		const external = v.pagesEl.querySelector('a[href="https://example.com/paper"]');
		let prevented = null;
		external.addEventListener("click", event => { prevented = event.defaultPrevented; event.preventDefault(); }, { once: true });
		external.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		return { prevented, target: external.target, label: v.pageLabels[0], links: v.pagesEl.querySelectorAll(".pr-pdf-link").length };
	});
	check("PDF 外链保留打开行为，页码标签已加载", pdfLinks.prevented === false && pdfLinks.target === "_blank" && pdfLinks.label === "i" && pdfLinks.links === 2, JSON.stringify(pdfLinks));
	await page.locator('[aria-label="跳转到 PDF 页面"]').click();
	await page.waitForFunction(() => window.__h.reader.currentPage === 2);
	await page.evaluate(() => window.__h.reader.goBack());
	check("PDF 内链可跳页并返回原位置", await page.evaluate(() => window.__h.reader.currentPage === 1));
	// Native selection is transparent; the reader supplies the drag preview.
	const dragLine = await page.evaluate(() => {
		const v = window.__h.reader;
		const span = v.pagesEl.querySelector(".textLayer span");
		const rects = Array.from(v.pagesEl.querySelectorAll(".textLayer span"), (s) => s.getBoundingClientRect())
			.filter((r) => r.width > 0 && r.height > 0);
		const top = Math.min(...rects.map((r) => r.top));
		const line = rects.filter((r) => Math.abs(r.top - top) < 4);
		return {
			native: getComputedStyle(span, "::selection").backgroundColor,
			y: top + Math.max(...line.map((r) => r.height)) / 2,
			x: Math.min(...line.map((r) => r.left)),
			right: Math.max(...line.map((r) => r.right)),
		};
	});
	check("原生选区高亮全程关闭，只留自绘色带", dragLine.native === "rgba(0, 0, 0, 0)", dragLine.native);
	await page.mouse.move(dragLine.x + 1, dragLine.y);
	await page.mouse.down();
	// Check while the pointer is still down, before mouseup finalizes actions.
	await page.mouse.move(dragLine.x + (dragLine.right - dragLine.x) * 0.4, dragLine.y, { steps: 3 });
	const midDrag = await page.evaluate(() => {
		const layer = window.__h.reader.pagesEl.querySelector(".pr-selection-layer");
		return {
			bands: layer ? layer.children.length : 0,
			fill: layer && layer.firstElementChild ? getComputedStyle(layer.firstElementChild).backgroundColor : null,
			chars: window.getSelection().toString().length,
		};
	});
	check("拖拽中（未松开鼠标）已显示自绘选区", midDrag.bands > 0 && midDrag.fill !== "rgba(0, 0, 0, 0)" && midDrag.chars > 0, JSON.stringify(midDrag));
	await page.mouse.up();
	await page.evaluate(() => window.__h.reader.clearSelection());
	const acrossPages = await page.evaluate(async () => {
		const v = window.__h.reader;
		await v.scrollToPage(2);
		const pages = v.pages.filter(p => p.wrapper.querySelector(".textLayer span"));
		const [first, second] = pages.slice(0, 2);
		if (!first || !second) return { mounted: pages.map(p => p.pageNumber) };
		const start = first.wrapper.querySelector(".textLayer span").firstChild;
		const end = second.wrapper.querySelector(".textLayer span").firstChild;
		const range = document.createRange();
		range.setStart(start, 0);
		range.setEnd(end, Math.min(3, end.textContent.length));
		const selection = window.getSelection();
		selection.removeAllRanges(); selection.addRange(range);
		document.dispatchEvent(new Event("selectionchange"));
		await new Promise(requestAnimationFrame);
		const bands = pages.slice(0, 2).map(p => p.selectionLayer.children.length);
		selection.setBaseAndExtent(end, Math.min(3, end.textContent.length), start, 0);
		document.dispatchEvent(new Event("selectionchange"));
		await new Promise(requestAnimationFrame);
		const reverse = pages.slice(0, 2).map(p => p.selectionLayer.children.length);
		v.refreshSelectionState();
		const payload = v.currentPayload;
		await v.commitHighlight("yellow", payload);
		const saved = v.data.annotations.map(a => ({ page: a.page, text: a.text, groupId: a.groupId }));
		await v.history.undo(); const afterUndo = v.data.annotations.length;
		await v.history.redo();
		const disk = await v.store.load(v.file.path);
		v.clearSelection();
		return { bands, reverse, pages: pages.slice(0, 2).map(p => p.pageNumber), saved, afterUndo, restored: disk.annotations.length };
	});
	check("跨页正反向选区两页均有可见色带", acrossPages.bands?.every(count => count > 0) && acrossPages.reverse?.every(count => count > 0), JSON.stringify(acrossPages));
	check("跨页高亮按页保存并整组撤销、重做", acrossPages.saved?.length === 2 && acrossPages.saved.every(a => a.text.length > 0) && acrossPages.saved[0].groupId === acrossPages.saved[1].groupId && acrossPages.afterUndo === 0 && acrossPages.restored === 2, JSON.stringify(acrossPages));
	const handles = await page.evaluate(async () => {
		const v = window.__h.reader; await v.scrollToPage(1);
		const spans = Array.from(v.pages[0].wrapper.querySelectorAll(".textLayer span"));
		const node = spans[0].firstChild;
		const endpoint = offset => { const span = spans.find(s => Number(s.dataset.prTextStart) < offset && Number(s.dataset.prTextEnd) >= offset); return [span.firstChild, offset - Number(span.dataset.prTextStart)]; };
		const [endNode, endOffset] = endpoint(9);
		window.getSelection().setBaseAndExtent(node, 0, endNode, endOffset);
		v.refreshSelectionState(); await v.commitHighlight("yellow", v.currentPayload);
		const ann = v.data.annotations.at(-1); v.activeAnnotationId = ann.id;
		await v.beginRangeEdit();
		const caret = document.createRange(); const [targetNode, targetOffset] = endpoint(3); caret.setStart(targetNode, targetOffset); caret.collapse(true);
		const b = caret.getClientRects()[0];
		return { id: ann.id, count: v.pagesEl.querySelectorAll(".pr-range-handle").length, x: b.left, y: b.top + b.height / 2 };
	});
	check("已有高亮显示两端范围手柄", handles.count === 2, JSON.stringify(handles));
	const endHandle = await page.locator('[aria-label="调整高亮结束位置"]').boundingBox();
	await page.mouse.move(endHandle.x + endHandle.width / 2, endHandle.y + endHandle.height / 2);
	await page.mouse.down(); await page.mouse.move(handles.x, handles.y, { steps: 5 }); await page.mouse.up();
	await page.waitForFunction(id => window.__h.reader.data.annotations.find(a => a.id === id)?.text === "Syn", handles.id);
	const rangeSaved = await page.evaluate(async id => {
		const v = window.__h.reader;
		const disk = await v.store.load(v.file.path);
		const text = disk.annotations.find(a => a.id === id)?.text;
		await v.history.undo();
		return { text, undo: v.data.annotations.find(a => a.id === id)?.text };
	}, handles.id);
	check("拖动范围手柄保存文字，撤销恢复原范围", rangeSaved.text === "Syn" && rangeSaved.undo === "Synthetic", JSON.stringify(rangeSaved));
	const renderOrder = await page.evaluate(async () => {
		const v = window.__h.reader, order = [];
		const original = v.renderer.renderPage.bind(v.renderer);
		v.renderer.renderPage = (...args) => { order.push(args[0]); return original(...args); };
		try { await v.scrollToPage(20); return order; }
		finally { v.renderer.renderPage = original; }
	});
	check("远跳优先渲染当前可见页", renderOrder[0] === 20, JSON.stringify(renderOrder));
	const last = await page.evaluate(() => window.__h.readerNavigate(30));
	check("远跳释放旧页面并加载末页", last.mounted.includes(30) && !last.mounted.includes(1) && last.mounted.length <= 8, JSON.stringify(last));
	const windowSearch = await page.evaluate(async () => {
		const v = window.__h.reader;
		v.openSearch(); v.searchInputEl.value = "finalmarker"; await v.runSearch();
		return { hits: v.searchHits.length, page: v.currentPage, marks: v.pagesEl.querySelectorAll(".pr-search-current").length };
	});
	check("窗口化后全文搜索能定位未读末页", windowSearch.hits === 1 && windowSearch.page === 30 && windowSearch.marks > 0, JSON.stringify(windowSearch));
	const singleLetterSearch = await page.evaluate(async () => {
		const v = window.__h.reader;
		let ticks = 0;
		const timer = setInterval(() => ticks++, 0);
		const start = performance.now();
		try {
			v.searchInputEl.value = "E"; await v.runSearch();
			let expected = 0;
			for (let p = 1; p <= v.renderer.numPages; p++) expected += ((await v.renderer.getPageTextEnsured(p)).match(/e/gi) || []).length;
			const page = v.pages.find(p => p.pageNumber === v.searchHits[v.currentHit].page);
			const marks = page.highlightLayer.querySelectorAll(".pr-search-hit").length;
			let scans = 0;
			const original = page.wrapper.querySelectorAll;
			page.wrapper.querySelectorAll = function (...args) { scans++; return original.apply(this, args); };
			try { await v.gotoHit(1); }
			finally { page.wrapper.querySelectorAll = original; }
			return { hits: v.searchHits.length, expected, ticks, marks, scans, current: v.currentHit, elapsed: Math.round(performance.now() - start) };
		} finally { clearInterval(timer); }
	});
	console.log("  单字搜索数据", JSON.stringify(singleLetterSearch));
	check("单字 E 保留全部命中，搜索期间界面可处理事件", singleLetterSearch.hits === singleLetterSearch.expected && singleLetterSearch.hits > 5000 && singleLetterSearch.ticks > 0 && singleLetterSearch.marks > 100, JSON.stringify(singleLetterSearch));
	check("同页切换命中复用坐标，不逐项扫描文字 DOM", singleLetterSearch.current === 1 && singleLetterSearch.scans <= 2, JSON.stringify(singleLetterSearch));
	await page.evaluate(() => window.__h.reader.closeSearch());
	const redraw = await page.evaluate(async () => {
		const v = window.__h.reader;
		const ann = { id: "window-note", type: "note", page: 30, rects: [{ x: 30, y: 220, width: 100, height: 12 }], text: "Synthetic", color: "yellow", note: "retained", createdAt: "", textOffset: 0, contextBefore: "", contextAfter: "" };
		v.data.annotations.push(ann); await v.persistAndRefresh([30]);
		await v.scrollToPage(1); await v.scrollToPage(30);
		return v.pages.find(p => p.pageNumber === 30).wrapper.querySelectorAll('[data-annotation-id="window-note"]').length;
	});
	check("页面释放重建后标注仍显示", redraw > 0);
	const layouts = await page.evaluate(async () => {
		const v = window.__h.reader, results = [];
		for (const mode of ["double-odd", "double-even", "single"]) {
			await v.setLayoutMode(mode); await v.scrollToPage(7);
			const p = v.pages.find(p => p.pageNumber === 7);
			results.push({ mode, mounted: v.mountedPages.has(7), width: p.widthAtScale1, height: p.heightAtScale1, count: v.mountedPages.size });
		}
		return results;
	});
	check("双页/单页导航保留混合纸张尺寸", layouts.every(r => r.mounted && r.width === 792 && r.height === 612 && r.count <= 8), JSON.stringify(layouts));
	await page.evaluate(async () => { await window.__h.reader.setLayoutMode("continuous"); });
	const cancelled = await page.evaluate(async () => {
		const v = window.__h.reader;
		await Promise.all([v.scrollToPage(15), v.scrollToPage(28), v.scrollToPage(2)]);
		await v.refreshPageWindow(); return window.__h.readerStats();
	});
	check("快速远跳不会挂回过期页面", cancelled.current === 2 && cancelled.mounted.includes(2) && !cancelled.mounted.includes(28) && !cancelled.failures.length, JSON.stringify(cancelled));
	const zoomed = await page.evaluate(async () => { await window.__h.reader.zoomBy(10); return window.__h.readerStats(); });
	check("高倍缩放单页像素预算有效", zoomed.maxPixels <= 8000000 && !zoomed.failures.length, JSON.stringify(zoomed));
	check("高倍缩放仍预加载前后相邻页", zoomed.mounted.includes(1) && zoomed.mounted.includes(2) && zoomed.mounted.includes(3), JSON.stringify(zoomed));
	const cachedFlip = await page.evaluate(async () => {
		const v = window.__h.reader, order = [];
		const original = v.renderer.renderPage.bind(v.renderer);
		v.renderer.renderPage = (...args) => { order.push(args[0]); return original(...args); };
		try { await v.scrollToPage(3); await v.scrollToPage(2); return order; }
		finally { v.renderer.renderPage = original; }
	});
	check("相邻页翻阅直接使用已渲染页面", !cachedFlip.includes(3) && !cachedFlip.includes(2), JSON.stringify(cachedFlip));
	const detail = await page.evaluate(async () => {
		const v = window.__h.reader;
		v.scrollToRect(2, { x: 30, y: 242, width: 80, height: 20 });
		const bounds = v.scrollEl.getBoundingClientRect();
		await Promise.all(v.pages.filter(p => v.mountedPages.has(p.pageNumber)).map(p => v.renderer.updateDetail(p, bounds)));
		const canvas = v.pagesEl.querySelector(".pr-detail-canvas");
		let ink = 0;
		if (canvas) { const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data; for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 150 && pixels[i + 3] > 0) ink++; }
		return canvas ? { pixels: canvas.width * canvas.height, ratio: canvas.width / parseFloat(canvas.style.width), dpr: window.devicePixelRatio, ink } : null;
	});
	check("高倍缩放可见区域使用高清裁剪画布", detail?.ratio >= detail?.dpr - 0.01 && detail.pixels <= 8000000 && detail.ink > 50, JSON.stringify(detail));
	const window300 = await page.evaluate(() => window.__h.openReader("/large.pdf"));
	check("300 页首屏资源不随全文增长", window300.pages === 300 && window300.mounted.length <= 8 && window300.canvasBytes <= window30.canvasBytes * 1.1, JSON.stringify(window300));
	const earlyRaster = await page.evaluate(async () => {
		const v = window.__h.reader, renderer = v.renderer;
		const slot = await renderer.createPlaceholder(10, 1, document);
		document.body.appendChild(slot.wrapper);
		const original = renderer.getPageLinks.bind(renderer);
		let reached, resume;
		const entered = new Promise(resolve => { reached = resolve; });
		const gate = new Promise(resolve => { resume = resolve; });
		renderer.getPageLinks = async (...args) => { reached(); await gate; return original(...args); };
		let finished = false;
		const pending = renderer.renderPage(10, 1, undefined, document, undefined, slot).then(rendered => { finished = true; return rendered; });
		try {
			await entered;
			const canvas = slot.wrapper.querySelector("canvas");
			const shown = !!canvas && canvas.isConnected && canvas.width > 0 && !finished;
			resume(); renderer.releasePage(await pending);
			return shown;
		} finally { resume(); renderer.getPageLinks = original; slot.wrapper.remove(); }
	});
	check("页面画面无需等待文本与链接全部完成", earlyRaster);
	const popupFlow = await page.evaluate(async () => {
		await window.__h.openReader();
		const v = window.__h.reader;
		const wait = async (ready) => {
			for (let i = 0; i < 100; i++) { if (ready()) return; await new Promise(r => setTimeout(r, 10)); }
			throw new Error("Selection flow timed out");
		};
		const select = () => {
			const spans = v.pages[0].wrapper.querySelectorAll(".textLayer span");
			const range = document.createRange();
			range.setStart(spans[0].firstChild, 0);
			range.setEnd(spans[2].firstChild, spans[2].textContent.length);
			const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
			v.refreshSelectionState(); return v.currentPayload;
		};
		let requests = 0;
		v.popup.deps.translate = async () => { requests++; return "测试译文"; };
		const payload = select(); v.popup.show(payload);
		let el = document.querySelector(".pr-popup");
		const compact = !el.querySelector("textarea") && getComputedStyle(el.querySelector(".pr-popup-translate")).display === "none" && el.getBoundingClientRect().height < 160;
		el.querySelector('[aria-label="直线"]').click();
		const before = v.data.annotations.length;
		const styleOnly = v.data.annotations.length === before && v.popupStyle === "underline";
		el.querySelector(".pr-popup-translate-btn").click();
		await wait(() => !v.popup.translating);
		const expanded = el.querySelector(".pr-popup-result").textContent === "测试译文" && getComputedStyle(el.querySelector(".pr-popup-result-actions")).display !== "none";
		v.popup.show(payload); el = document.querySelector(".pr-popup");
		const cachedCollapsed = getComputedStyle(el.querySelector(".pr-popup-translate")).display === "none";
		el.querySelector(".pr-popup-translate-btn").click();
		const cachedOnce = requests === 1 && el.querySelector(".pr-popup-result").textContent === "测试译文";
		el.querySelector('[aria-label="添加批注"]').click();
		await wait(() => !!document.querySelector(".pr-popup textarea"));
		const ann = v.data.annotations.at(-1), id = ann.id;
		const currentStyle = ann.style === "underline" && v.data.annotations.length === before + 1;
		const input = document.querySelector(".pr-popup textarea"); input.value = "第一行\n第二行";
		document.querySelector('[aria-label="保存批注"]').click();
		await wait(() => !v.popup.isVisible);
		const sameAnnotation = v.data.annotations.length === before + 1 && v.data.annotations.find(a => a.id === id).note === "第一行\n第二行";
		v.openHighlightMenu(v.data.annotations.find(a => a.id === id), 100, 100);
		const reopen = document.querySelector(".pr-popup textarea").value === "第一行\n第二行";
		v.clearSelection(); v.setTextTool("underline");
		const pressed = [...v.selectionActions.el.querySelectorAll("button")].some(b => b.textContent === "下划线" && b.getAttribute("aria-pressed") === "true");
		select(); v.popupStyle = "highlight"; v.onMouseUp(); v.onMouseUp();
		await wait(() => !v.savingHighlight && !v.currentPayload);
		const autoSave = v.data.annotations.length === before + 2 && v.data.annotations.at(-1).style === "underline" && !v.popup.isVisible;
		v.setTextTool(null); select(); v.onMouseUp(); await wait(() => v.popup.isVisible);
		const selectMode = v.data.annotations.length === before + 2 && !document.querySelector(".pr-popup textarea");
		v.clearSelection();
		return { compact, styleOnly, expanded, cachedCollapsed, cachedOnce, currentStyle, sameAnnotation, reopen, pressed, autoSave, selectMode };
	});
	for (const [name, passed] of Object.entries(popupFlow)) check(`选区与批注流程 ${name}`, passed, JSON.stringify(popupFlow));
	await require("./readerControls.cjs")(page, check);
	const hiddenPosition = await page.evaluate(async () => {
		const v = window.__h.reader;
		const find = v.app.vault.getAbstractFileByPath;
		v.app.vault.getAbstractFileByPath = path => path === v.file.path ? v.file : find(path);
		await v.scrollToPage(1); v.schedulePositionSave();
		const expected = v.lastReadingPosition.page;
		v.contentEl.style.display = "none"; await v.savePositionNow();
		const saved = v.plugin.settings.readingPositions[v.file.path].page;
		v.contentEl.style.display = "";
		v.app.vault.getAbstractFileByPath = find;
		return { expected, saved };
	});
	check("关闭或隐藏视图不覆盖阅读位置", hiddenPosition.expected === 1 && hiddenPosition.saved === 1, JSON.stringify(hiddenPosition));
	const streaming = await page.evaluate(() => window.__h.streamingReaderChecks());
	for (const [name, passed] of Object.entries(streaming)) check(`真实流式选区翻译 ${name}`, passed, JSON.stringify(streaming));
	await page.evaluate(() => window.__h.openReader("/large.pdf"));
	await page.evaluate(async () => {
		const v = window.__h.reader;
		const pending = v.scrollToPage(299);
		await v.onClose(); await pending;
	});
	const closed = await page.evaluate(async () => { const v = window.__h.reader; await window.__h.closeReader(); return { pages: v.pages.length, task: !!v.pageRender, children: v.children.length }; });
	check("关闭释放页面与组件", closed.pages === 0 && !closed.task && closed.children === 0, JSON.stringify(closed));
	const english = await browser.newPage();
	await english.addInitScript(() => { globalThis.__testLanguage = "en"; });
	await english.goto(process.env.PR_TEST_URL);
	await english.waitForFunction(() => !!window.__h);
	await english.evaluate(() => window.__h.openReader());
	const englishUi = await english.evaluate(() => {
		const labels = [...window.__h.reader.headerEl.querySelectorAll("button")].map(b => b.getAttribute("aria-label") || b.textContent);
		return { zoom: labels.includes("Zoom out"), select: labels.includes("Select text"), comment: labels.includes("Comment"), chinese: labels.some(label => /[\u3400-\u9fff]/.test(label || "")) };
	});
	check("英文界面使用宿主语言", englishUi.zoom && englishUi.select && englishUi.comment && !englishUi.chinese, JSON.stringify(englishUi));
	await english.close();
	await browser.close();
	if (failures > 0) {
		console.log(`\nACCEPTANCE FAILED (${failures} failures)`);
		process.exit(1);
	}
	console.log("\nACCEPTANCE PASSED");
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
