module.exports = async function readerControls(page, check) {
	await page.evaluate(() => window.__h.openReader());
	await page.evaluate(() => {
		const v = window.__h.reader;
		window.__explainOriginal = v.popup.deps.onExplain;
		v.popup.deps.onExplain = payload => { window.__explainedText = payload.text; };
		v.popup.show({ text: '解释所选文字', page: 1, rects: [], anchorRect: new DOMRect(100, 100, 100, 20) });
	});
	const aiLayout = await page.evaluate(() => {
		const tr = document.querySelector('.pr-popup-translate-btn').getBoundingClientRect();
		const ai = document.querySelector('.pr-popup-explain-btn').getBoundingClientRect();
		return Math.abs(tr.width - ai.width) < 1 && Math.abs(tr.top - ai.top) < 1 && ai.left >= tr.right && ai.width >= 65;
	});
	check('翻译和 AI 解释同排等宽且文字有空间', aiLayout);
	await page.locator('.pr-popup-explain-btn').click();
	check('AI 解释使用弹窗保存的原选区', await page.evaluate(() => window.__explainedText === '解释所选文字'));
	await page.evaluate(() => { const v = window.__h.reader; v.popup.hide(); v.popup.deps.onExplain = window.__explainOriginal; });
	await page.evaluate(() => {
		const panel = window.__h.reader.panel;
		window.__panelOriginal = { llm: panel.llm, callbacks: panel.callbacks };
		window.__copyOutput = '';
		Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
			writeText: async text => { window.__copyOutput = text; },
		} });
		window.__answerGate = new Promise(resolve => { window.__answerReady = resolve; });
		panel.llm = { async *streamChat(messages) {
			await window.__answerGate;
			window.__explainPrompt = messages[0].content;
			yield messages.length > 2 ? '**第二条回答**' : '**核心含义**\n简洁说明。';
		} };
		panel.callbacks = { ...panel.callbacks, onAnswered() {} };
		panel.prepareContext('explain', { text: 'term', page: 1, rects: [], anchorRect: new DOMRect() });
	});
	check('读取跨页上下文时立即显示等待状态', await page.locator('.pr-answer-waiting').textContent() === '正在读取论文上下文…');
	await page.evaluate(() => {
		const panel = window.__h.reader.panel;
		panel.openExplain({ text: 'term', page: 1, rects: [], anchorRect: new DOMRect() }, '[page 1]\nIntroduction start\n[page 2]\nIntroduction continuation');
	});
	check('首段文字到达前显示等待动画和状态文字', await page.locator('.pr-answer-waiting').isVisible() &&
		await page.locator('.pr-answer-dots > span').count() === 3 &&
		await page.locator('.pr-answer-waiting').getAttribute('role') === 'status');
	await page.emulateMedia({ reducedMotion: 'reduce' });
	check('减少动态效果时停止等待动画', await page.evaluate(() => getComputedStyle(document.querySelector('.pr-answer-dots > span')).animationName === 'none'));
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await page.evaluate(() => window.__answerReady());
	await page.waitForFunction(() => !window.__h.reader.panel.streaming);
	check('正文出现后移除等待动画并结束忙碌状态', await page.locator('.pr-answer-waiting').count() === 0 &&
		await page.locator('.pr-msg-assistant').getAttribute('aria-busy') === 'false');
	check('解释系统提示词要求 80% ASD-STE100 风格和简洁回答', await page.evaluate(() =>
		window.__explainPrompt.includes('80% 的 ASD-STE100') && window.__explainPrompt.includes('回答保持简洁')));
	check('回答底部显示复制回答按钮', await page.locator('.pr-msg-copy').isVisible());
	check('面板显示实际跨页范围', await page.locator('.pr-panel-context').textContent() === '上下文：第 1, 2 页');
	await page.evaluate(async () => {
		const panel = window.__h.reader.panel;
		panel.inputEl.value = '再解释';
		await panel.sendFollowUp();
	});
	await page.waitForFunction(() => !window.__h.reader.panel.streaming);
	await page.locator('.pr-msg-copy').first().click();
	check('复制历史回答保留原始 Markdown 且不混入追问', await page.evaluate(() => window.__copyOutput === '**核心含义**\n简洁说明。'));
	await page.locator('.pr-msg-copy').last().click();
	check('复制新回答使用对应模型输出', await page.evaluate(() => window.__copyOutput === '**第二条回答**'));
	await page.evaluate(() => { window.__h.reader.panel.regenerate(); });
	await page.waitForFunction(() => !window.__h.reader.panel.streaming);
	check('重新生成后每条回答只有一个复制按钮', await page.locator('.pr-msg-copy').count() === 2);
	await page.evaluate(() => {
		const panel = window.__h.reader.panel;
		panel.close(); panel.clearConversation();
		Object.assign(panel, window.__panelOriginal);
		delete navigator.clipboard;
	});
	const toolbar = await page.evaluate(() => {
		const v = window.__h.reader;
		v.setTextTool(null); v.clearSelection();
		const button = label => [...v.headerEl.querySelectorAll('button')].find(b => b.textContent === label);
		const pointer = { enabled: !button('选择文字').disabled && !button('下划线').disabled,
			bright: getComputedStyle(button('选择文字')).opacity === '1' && getComputedStyle(button('下划线')).opacity === '1',
			empty: v.selectionActions.colorButton.disabled && !v.headerEl.querySelector('.pr-tool-active'),
			noteDisabled: button('批注').disabled && getComputedStyle(button('批注')).opacity === '0.4' };
		button('高亮').click();
		const highlight = button('高亮').getAttribute('aria-pressed') === 'true' && !v.selectionActions.colorButton.disabled &&
			v.selectionActions.colorButton.querySelector('.pr-color-swatch').style.backgroundColor !== 'transparent';
		button('高亮').click(); const toggleOff = !v.textTool && v.selectionActions.colorButton.disabled;
		button('下划线').click(); v.setDrawingTool('pen');
		const exclusive = !v.headerEl.querySelector('.pr-tool-active') && v.penBtn.getAttribute('aria-pressed') === 'true' && !v.selectionActions.colorButton.disabled;
		v.setDrawingTool(null);
		const reset = v.selectionActions.colorButton.disabled;
		return { ...pointer, highlight, toggleOff, exclusive, reset };
	});
	for (const [name, ok] of Object.entries(toolbar)) check(`Zotero 工具栏状态 ${name}`, ok, JSON.stringify(toolbar));
	const bands = await page.evaluate(() => {
		const v = window.__h.reader;
		v.data.annotations.push({ id: 'seam-test', type: 'highlight', page: 1, style: 'highlight', color: 'yellow', text: 'three lines',
			rects: [{ x: 70, y: 100, width: 100, height: 11.10398 }, { x: 70, y: 110.9271, width: 100, height: 11.10398 }, { x: 70, y: 121.9344, width: 100, height: 11.10398 }] });
		v.redrawHighlights(v.pages[0]);
		const boxes = [...document.querySelectorAll('.pr-highlight-rect[data-annotation-id="seam-test"]')].map(el => el.getBoundingClientRect());
		const ok = boxes.length === 3 && boxes[0].bottom <= boxes[1].top && boxes[1].bottom <= boxes[2].top;
		v.data.annotations = v.data.annotations.filter(a => a.id !== 'seam-test'); v.redrawHighlights(v.pages[0]);
		return ok;
	});
	check('实际高亮 DOM 的相邻行没有重叠深色细线', bands);
	const existingAnchor = await page.evaluate(async () => {
		const v = window.__h.reader; await v.scrollToPage(1); v.setTextTool(null);
		const ann = { id: 'existing-comment-test', type: 'highlight', page: 1, color: 'yellow', text: 'test', note: '原有评论', rects: [{ x: 50, y: 70, width: 100, height: 20 }], createdAt: new Date().toISOString() };
		v.data.annotations.push(ann); v.redrawAllHighlights();
		const page = v.pages[0].wrapper.getBoundingClientRect();
		return { x: page.left + 70 * v.scale, y: page.top + 80 * v.scale };
	});
	await page.mouse.click(existingAnchor.x, existingAnchor.y);
	const existing = await page.evaluate(() => ({ selected: !!document.querySelector('.pr-highlight-selection[data-annotation-id="existing-comment-test"]'),
		comment: document.querySelector('.pr-annotation-popup textarea')?.value === '原有评论',
		compact: !document.querySelector('.pr-annotation-options').open && !document.querySelector('.pr-annotation-popup .pr-popup-translate-btn') }));
	for (const [name, ok] of Object.entries(existing)) check(`单击已有高亮 ${name}`, ok, JSON.stringify(existing));
	await page.locator('.pr-annotation-popup textarea').fill('未保存的评论草稿');
	await page.mouse.click(10, 10);
	await page.evaluate(async () => { await window.__h.reader.scrollToPage(1); });
	const reopenedAnchor = await page.evaluate(() => { const v = window.__h.reader, r = v.pages[0].wrapper.getBoundingClientRect(); return { x: r.left + 70 * v.scale, y: r.top + 80 * v.scale }; });
	await page.mouse.click(reopenedAnchor.x, reopenedAnchor.y);
	check('关闭再打开保留评论草稿', await page.locator('.pr-annotation-popup textarea').inputValue() === '未保存的评论草稿');
	await page.locator('.pr-annotation-popup [aria-label="保存批注"]').click();
	await page.waitForFunction(() => !window.__h.reader.popup.isVisible);
	const commentSaved = await page.evaluate(async () => {
		const v = window.__h.reader, saved = await v.store.load(v.file.path);
		return saved.annotations.find(a => a.id === 'existing-comment-test')?.note === '未保存的评论草稿' && v.data.annotations.filter(a => a.id === 'existing-comment-test').length === 1;
	});
	check('评论保存到原高亮且不创建重复标注', commentSaved);
	await page.mouse.click(reopenedAnchor.x, reopenedAnchor.y);
	await page.locator('.pr-annotation-options summary').click();
	check('更多菜单展开颜色和样式', await page.locator('.pr-annotation-popup .pr-color-dot').first().isVisible());
	await page.locator('.pr-annotation-popup textarea').press('Escape');
	check('Escape 清除标注选中效果', await page.locator('.pr-highlight-selection').count() === 0);
	await page.evaluate(async () => { await window.__h.reader.deleteHighlight('existing-comment-test'); window.__h.reader.history.clear(); });
	const ink = await page.evaluate(async () => {
		const v = window.__h.reader;
		await v.scrollToPage(1); v.setDrawingTool(null);
		const ann = { id: 'width-control-ink', type: 'ink', page: 1, color: 'yellow', text: '', rects: [{x: 50,y: 70,width: 100,height: 30}],
			ink: { width: 4, points: [50,70,100,100,150,70] }, createdAt: new Date().toISOString() };
		v.data.annotations.push(ann); v.redrawAllInk();
		v.pages[0].inkLayer.querySelector('[data-annotation-id="width-control-ink"]').dispatchEvent(new MouseEvent('click', {bubbles:true,clientX:200,clientY:200}));
		return { selected: v.selectedInkId === ann.id, editor: !!document.querySelector('.pr-popup .pr-ink-width-slider') };
	});
	check('选中普通笔迹显示线宽编辑器', ink.selected && ink.editor, JSON.stringify(ink));
	await page.locator('.pr-popup .pr-color-dot[aria-label="标注 red"]').click();
	await page.waitForFunction(() => window.__h.reader.data.annotations.find(a => a.id === 'width-control-ink')?.color === 'red' && window.__h.reader.history.canUndo);
	const color = await page.evaluate(async () => {
		const v=window.__h.reader, find=()=>v.data.annotations.find(a=>a.id==='width-control-ink');
		const visible=v.pages[0].inkLayer.querySelector('[data-annotation-id="width-control-ink"]').getAttribute('stroke')===v.plugin.settings.highlightColors.red;
		await v.history.undo(); const undone=find().color==='yellow'; await v.history.redo();
		v.onInkClick(find(),200,200); v.history.clear(); return {visible,undone,redone:find().color==='red'};
	});
	for (const [name,ok] of Object.entries(color)) check(`普通笔迹改色 ${name}`,ok);
	const preview = await page.evaluate(() => {
		const v=window.__h.reader, range=document.querySelector('.pr-popup .pr-ink-width-slider');
		for (const value of ['5.5','8.2','9.3']) { range.value=value; range.dispatchEvent(new Event('input',{bubbles:true})); }
		return { width:v.data.annotations.find(a=>a.id==='width-control-ink').ink.width, history:v.history.undoStack.length,
			number:document.querySelector('.pr-popup .pr-ink-width-number').value };
	});
	check('拖动实时预览并同步数值，预览不新增撤销记录', preview.width===9.3 && preview.number==='9.3' && preview.history===0,JSON.stringify(preview));
	await page.locator('.pr-popup .pr-ink-width-slider').dispatchEvent('change');
	await page.waitForFunction(()=>window.__h.reader.history.undoStack.length===1);
	const widths = await page.evaluate(async () => {
		const v=window.__h.reader, find=()=>v.data.annotations.find(a=>a.id==='width-control-ink');
		await v.history.undo(); const undone=find().ink.width===4; await v.history.redo();
		return {undone,redone:find().ink.width===9.3};
	});
	check('一次滑动对应一次撤销且可重做',widths.undone&&widths.redone,JSON.stringify(widths));
	await page.locator('.pr-popup .pr-ink-width-number').fill('3.7');
	await page.locator('.pr-popup .pr-ink-width-number').press('Enter');
	await page.waitForFunction(()=>window.__h.reader.history.undoStack.length===2);
	const input = await page.evaluate(async () => {
		const v=window.__h.reader, ann=v.data.annotations.find(a=>a.id==='width-control-ink');
		const saved=await v.store.load(v.file.path);
		const exact=ann.ink.width===3.7 && saved.annotations.find(a=>a.id===ann.id)?.ink.width===3.7;
		v.popup.hide(); v.selectedInkId=null; v.editingNoteId=null;
		v.openPenMenu(new MouseEvent('click',{clientX:200,clientY:100}));
		return exact;
	});
	check('数值输入支持小数线宽',input);
	await page.locator('.pr-pen-popover .pr-ink-width-number').fill('6.4');
	await page.locator('.pr-pen-popover .pr-ink-width-number').press('Enter');
	const defaultWidth = await page.evaluate(async () => {
		const v=window.__h.reader, width=v.penWidthPx(); v.closePenMenu();
		const unchanged=v.data.annotations.find(a=>a.id==='width-control-ink').ink.width===3.7;
		await v.deleteHighlight('width-control-ink'); v.history.clear();
		return {width,unchanged};
	});
	check('未选中时仅设置后续画笔线宽',defaultWidth.width===6.4&&defaultWidth.unchanged,JSON.stringify(defaultWidth));
	const keyboard = await page.evaluate(async () => {
		const v = window.__h.reader;
		const wait = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(r => setTimeout(r, 20)); if (!predicate()) throw Error('controls wait timeout'); };
		const before = document.createElement('button'); v.contentEl.appendChild(before); before.focus();
		v.openSearch(); v.closeSearch(); const focusRestored = document.activeElement === before; before.remove();
		v.scrollEl.focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }));
		const penOn = v.drawingTool === 'pen';
		v.pageInputEl.focus(); v.pageInputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }));
		const typingSafe = v.drawingTool === 'pen';
		v.setDrawingTool(null);
		v.sidebarCollapsed = false; v.sidebar.setCollapsed(false);
		const first = v.sidebar.el.querySelector('[data-page-number="1"]'); first.focus();
		first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
		await wait(() => v.currentPage === 2 && v.mountedPages.has(2));
		const thumbNav = document.activeElement.dataset.pageNumber === '2' && document.activeElement.getAttribute('aria-current') === 'page';
		v.hlMenu.show(100, 100, 'yellow');
		const colors = document.querySelectorAll('.pr-hl-menu .pr-color-dot'); colors[0].focus();
		colors[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
		const colorNav = document.activeElement === colors[colors.length - 1];
		v.hlMenu.hide(); v.sidebarCollapsed = true; v.sidebar.setCollapsed(true);
		return { focusRestored, penOn, typingSafe, thumbNav, colorNav };
	});
	for (const [name, ok] of Object.entries(keyboard)) check(`阅读键盘交互 ${name}`, ok, JSON.stringify(keyboard));
	const retry = await page.evaluate(async () => {
		const v = window.__h.reader, original = v.renderer.renderPage;
		let injected = false;
		v.renderer.renderPage = function (number, ...args) { if (number === 2 && !injected) { injected = true; throw Error('injected page failure'); } return original.call(this, number, ...args); };
		await v.renderAll();
		const slot = v.pages.find(p => p.pageNumber === 2);
		const shown = v.failedPages.has(2) && !!slot.wrapper.querySelector('.pr-page-error button');
		await v.scrollToPage(3); const navigable = v.mountedPages.has(3);
		await v.scrollToPage(2); slot.wrapper.querySelector('.pr-page-error button').click();
		for (let i = 0; i < 150 && !v.mountedPages.has(2); i++) await new Promise(r => setTimeout(r, 20));
		v.renderer.renderPage = original;
		return { shown, navigable, recovered: v.mountedPages.has(2) && !v.failedPages.has(2) && !slot.wrapper.querySelector('.pr-page-error') };
	});
	for (const [name, ok] of Object.entries(retry)) check(`单页失败恢复 ${name}`, ok, JSON.stringify(retry));
	const gesture = await page.evaluate(async () => {
		const v = window.__h.reader; await v.scrollToPage(2);
		const slot = v.pages.find(p => p.pageNumber === 2), r = slot.wrapper.getBoundingClientRect(), viewport = v.scrollEl.getBoundingClientRect();
		const x = Math.max(r.left, viewport.left) + 80, y = Math.max(r.top, viewport.top) + 80;
		const scale = v.scale, pdfX = (x - r.left) / scale, pdfY = (y - r.top) / scale;
		let renders = 0; const original = v.renderAll;
		v.renderAll = function (...args) { renders++; return original.apply(this, args); };
		const normal = new WheelEvent('wheel', { deltaY: -20, cancelable: true });
		v.scrollEl.dispatchEvent(normal);
		for (let i = 0; i < 4; i++) v.scrollEl.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -20, clientX: x, clientY: y, cancelable: true }));
		for (let i = 0; i < 150; i++) { await new Promise(r => setTimeout(r, 20)); if (v.scale !== scale && !v.wheelZoomRunning && v.wheelZoomTimer === null) break; }
		v.renderAll = original;
		const after = v.pages.find(p => p.pageNumber === 2).wrapper.getBoundingClientRect();
		return { nativeWheel: !normal.defaultPrevented, grew: v.scale > scale, batched: renders === 1,
			anchor: Math.abs(after.left + pdfX * v.scale - x) < 2 && Math.abs(after.top + pdfY * v.scale - y) < 2,
			dx: after.left + pdfX * v.scale - x, dy: after.top + pdfY * v.scale - y, horizontalOverflow: v.scrollEl.scrollWidth - v.scrollEl.clientWidth };
	});
	for (const [name, ok] of Object.entries(gesture).filter(([,value]) => typeof value === "boolean")) check(`滚轮与捏合缩放 ${name}`, ok, JSON.stringify(gesture));
};
