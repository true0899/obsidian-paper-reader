import { t } from "../i18n";
import { Menu, setIcon } from "obsidian";
import { COLOR_KEYS } from "../settings";
import type { AnnotationStyle } from "../storage/annotationStore";

export interface SelectionActionsCallbacks {
	getColor: () => string;
	getStyle: () => AnnotationStyle;
	getMode: () => AnnotationStyle | null;
	isDrawing: () => boolean;
	canPickColor: () => boolean;
	setMode: (style: AnnotationStyle | null) => void;
	/** color picked in the marker menu: apply to selection, or set default */
	applyColor: (colorKey: string) => void;
	/** style picked in the marker menu: activate the text tool */
	applyStyle: (style: AnnotationStyle) => void;
	onClearHighlight: () => void;
	onCopy: () => void;
	/** 批注 placeholder for M1 */
	onNote: () => void;
	onTranslate: () => void;
	onExplain: () => void;
	onAsk: () => void;
}

export const COLOR_LABELS: Record<string, string> = {
	yellow: t("黄色"),
	red: t("红色"),
	green: t("绿色"),
	blue: t("蓝色"),
	purple: t("紫色"),
	pink: t("粉色"),
	orange: t("橙色"),
};

const STYLE_ITEMS: { key: AnnotationStyle; label: string; icon: string | null }[] = [
	{ key: "highlight", label: t("实心高亮"), icon: "highlighter" },
	{ key: "underline", label: t("下划线"), icon: "underline" },
	{ key: "wavy", label: t("波浪线"), icon: "waves" },
	{ key: "strikethrough", label: t("删除线"), icon: "strikethrough" },
];

/**
 * Selection action group embedded in the view header:
 * Text tools stay available without a selection. Selection actions require text.
 */
export class SelectionActions {
	readonly el: HTMLElement;
	readonly secondaryEl: HTMLDetailsElement;
	readonly colorButton: HTMLButtonElement;
	private buttons: HTMLButtonElement[] = [];
	private colorSwatch: HTMLElement;
	private opGroup: HTMLElement;
	private modeButtons = new Map<AnnotationStyle | null, HTMLButtonElement>();

	constructor(
		private callbacks: SelectionActionsCallbacks,
		private getColors: () => Record<string, string>
	) {
		this.el = createDiv({ cls: "pr-actions" });

		// Annotation tools; color selection is a separate dropdown.
		const hlGroup = this.el.createDiv({ cls: "pr-action-group" });
		const select = hlGroup.createEl("button", { cls: "pr-header-btn clickable-icon" });
		setIcon(select, "mouse-pointer-2");
		select.createSpan({ cls: "pr-sr-only", text: t("选择文字") });
		select.addEventListener("mousedown", e => e.preventDefault());
		select.addEventListener("click", () => this.callbacks.setMode(null));
		this.modeButtons.set(null, select);
		// the marker button stays clickable without a selection (switch defaults)
		const marker = hlGroup.createEl("button", {
			cls: "pr-marker-btn clickable-icon",
		});
		marker.createSpan({ cls: "pr-sr-only", text: t("高亮") });
		// don't steal focus / collapse the PDF selection when clicked
		marker.addEventListener("mousedown", (e) => e.preventDefault());
		const iconWrap = marker.createSpan({ cls: "pr-marker-icon" });
		setIcon(iconWrap, "highlighter");

		marker.addEventListener("click", () => this.callbacks.setMode(this.callbacks.getMode() === "highlight" ? null : "highlight"));
		this.modeButtons.set("highlight", marker);

		const underline = hlGroup.createEl("button", { cls: "pr-header-btn clickable-icon", attr: { type: "button" } });
		setIcon(underline, "underline");
		underline.createSpan({ cls: "pr-sr-only", text: t("下划线") });
		underline.addEventListener("mousedown", e => e.preventDefault());
		underline.addEventListener("click", () => this.callbacks.setMode(this.callbacks.getMode() === "underline" ? null : "underline"));
		this.modeButtons.set("underline", underline);
		this.mkBtn(hlGroup, "sticky-note", t("批注"), () => this.callbacks.onNote());

		this.colorButton = createEl("button", { cls: "pr-header-btn pr-color-picker clickable-icon", attr: { type: "button", "aria-label": t("标注颜色"), "aria-haspopup": "menu" } });
		this.colorSwatch = this.colorButton.createSpan({ cls: "pr-color-swatch" });
		const chevron = this.colorButton.createSpan({ cls: "pr-color-chevron" });
		setIcon(chevron, "chevron-down");
		this.colorButton.addEventListener("mousedown", e => e.preventDefault());
		this.colorButton.addEventListener("click", e => this.openMarkerMenu(e));

		// Keep reader-specific actions available without crowding the annotation tools.
		this.secondaryEl = createEl("details", { cls: "pr-actions-more" });
		const toggle = this.secondaryEl.createEl("summary", { cls: "pr-header-btn clickable-icon", attr: { role: "button" } });
		toggle.addEventListener("mousedown", e => e.preventDefault());
		setIcon(toggle, "ellipsis");
		toggle.createSpan({ cls: "pr-sr-only", text: t("更多选区操作") });
		const opGroup = this.secondaryEl.createDiv({ cls: "pr-actions-extra" });
		this.opGroup = opGroup;
		this.secondaryEl.addEventListener("toggle", () => {
			if (!this.secondaryEl.open) return;
			const rect = toggle.getBoundingClientRect();
			opGroup.style.top = `${rect.bottom + 4}px`;
			opGroup.style.right = `${Math.max(8, (toggle.ownerDocument.defaultView?.innerWidth ?? rect.right) - rect.right)}px`;
		});
		this.secondaryEl.addEventListener("keydown", e => { if (e.key === "Escape") { this.secondaryEl.open = false; toggle.focus(); } });
		this.secondaryEl.addEventListener("focusout", e => { if (!this.secondaryEl.contains(e.relatedTarget as Node | null)) this.secondaryEl.open = false; });
		opGroup.addEventListener("click", e => { if ((e.target as Element).closest("button")) this.secondaryEl.open = false; });
		for (const style of STYLE_ITEMS.filter(s => s.key === "wavy" || s.key === "strikethrough")) {
			const button = opGroup.createEl("button", { cls: "pr-header-btn clickable-icon", attr: { type: "button" } });
			setIcon(button, style.icon!);
			button.createSpan({ text: style.label });
			button.addEventListener("mousedown", e => e.preventDefault());
			button.addEventListener("click", () => this.callbacks.setMode(this.callbacks.getMode() === style.key ? null : style.key));
			this.modeButtons.set(style.key, button);
		}
		this.mkBtn(opGroup, "eraser", t("清除选区内的高亮"), () => this.callbacks.onClearHighlight());
		this.mkBtn(opGroup, "copy", t("复制"), () => this.callbacks.onCopy());
		this.mkBtn(opGroup, "languages", t("翻译"), () => this.callbacks.onTranslate());
		this.mkBtn(opGroup, "sparkles", t("AI 解释"), () => this.callbacks.onExplain());
		this.mkBtn(opGroup, "message-circle-question", t("AI 问答"), () =>
			this.callbacks.onAsk()
		);

		this.refreshIndicator();
		this.setEnabled(false);
	}

	private mkBtn(
		parent: HTMLElement,
		icon: string,
		tooltip: string,
		onClick: () => void
	): HTMLButtonElement {
		const btn = parent.createEl("button", { cls: "pr-header-btn clickable-icon" });
		setIcon(btn, icon);
		btn.createSpan({ cls: parent.hasClass("pr-actions-extra") ? "" : "pr-sr-only", text: tooltip });
		// don't steal focus / collapse the PDF selection when clicked
		btn.addEventListener("mousedown", (e) => e.preventDefault());
		btn.addEventListener("click", onClick);
		this.buttons.push(btn);
		return btn;
	}

	/** Prepend header controls that collapse into this menu when the view is narrow. */
	addOverflowItems(items: { icon: string; label: string; cls: string; onClick: () => void }[]): HTMLButtonElement[] {
		const first = this.opGroup.firstChild;
		const buttons = items.map(({ icon, label, cls, onClick }) => {
			const btn = createEl("button", { cls: `pr-header-btn clickable-icon ${cls}`, attr: { type: "button" } });
			setIcon(btn, icon);
			btn.createSpan({ text: label });
			btn.addEventListener("mousedown", e => e.preventDefault());
			btn.addEventListener("click", onClick);
			this.opGroup.insertBefore(btn, first);
			return btn;
		});
		this.opGroup.insertBefore(createDiv({ cls: "pr-menu-separator pr-only-compact" }), first);
		return buttons;
	}

	/** Sync the active tool and standalone color swatch. */
	refreshIndicator(): void {
		const key = this.callbacks.getColor();
		const enabled = this.callbacks.canPickColor();
		this.colorButton.disabled = !enabled;
		// Keep showing the default color while disabled; CSS dims it.
		this.colorSwatch.style.backgroundColor = this.getColors()[key] ?? key;
		for (const [mode, button] of this.modeButtons) {
			const active = !this.callbacks.isDrawing() && mode !== null && this.callbacks.getMode() === mode;
			button.toggleClass("pr-tool-active", active);
			button.setAttr("aria-pressed", String(active));
		}
	}

	private openMarkerMenu(e: MouseEvent): void {
		const menu = new Menu();
		const colors = this.getColors();
		for (const key of COLOR_KEYS) {
			menu.addItem((item) => {
				// color dot inside the title; setChecked shows a ✓ on the left
				const frag = createFragment((fragment) => {
					const dot = fragment.createSpan({ cls: "pr-menu-dot" });
					dot.style.backgroundColor = colors[key] ?? key;
					fragment.createSpan({ text: COLOR_LABELS[key] ?? key });
				});
				item
					.setTitle(frag)
					.setChecked(this.callbacks.getColor() === key)
					.onClick(() => this.callbacks.applyColor(key));
			});
		}
		menu.showAtMouseEvent(e);
	}

	setEnabled(enabled: boolean): void {

		for (const btn of this.buttons) {
			btn.disabled = !enabled;
		}
		this.refreshIndicator();
	}
}
