import { createInkWidthControl } from "./InkWidthControl";
import { t } from "../i18n";
import { navigateColorButtons } from "./colorKeyboard";
import { Notice, setIcon } from "obsidian";
import type { Annotation, AnnotationStyle } from "../storage/annotationStore";
import type { SelectionPayload } from "../pdfview/selection";
import { popupCacheKey, PopupCachedState } from "../pdfview/popupCache";
import { COLOR_KEYS } from "../settings";

export interface SelectionPopupDeps {
	getColors: () => Record<string, string>;
	getStyle: () => AnnotationStyle;
	getPageLabel?: (page: number) => string;
	onDismiss?: () => void;
	/** style button clicked: update session default (and edit target, if any) */
	setStyle: (style: AnnotationStyle) => void;
	setInkWidth?: (width: number, commit: boolean, id: string) => void | Promise<void>;
	/** color dot clicked: create annotation from selection, or recolor edit target */
	applyAnnotation: (colorKey: string) => void;
	copySelection: () => void;
	onNote?: () => void;
	onExplain?: (payload: SelectionPayload) => void;
	/** create note from selection, or update edit target's note text */
	submitNote: (text: string) => Promise<boolean>;
	deleteAnnotation?: (id: string) => Promise<void>;
	/** stream a translation; onChunk receives the full text so far */
	translate: (payload: SelectionPayload, onChunk: (full: string) => void, signal?: AbortSignal) => Promise<string>;
	insertTranslation: (translation: string) => Promise<void>;
	/** view-level per-selection state cache (translation + note draft) */
	getCached: (key: string) => PopupCachedState | undefined;
	setCached: (key: string, state: PopupCachedState) => void;
}

const STYLE_ORDER: { key: AnnotationStyle; icon: string | null; label: string }[] = [
	{ key: "highlight", icon: "highlighter", label: t("实心高亮") },
	{ key: "underline", icon: "underline", label: t("直线") },
	{ key: "wavy", icon: null, label: t("波浪线") },
	{ key: "strikethrough", icon: "strikethrough", label: t("删除线") },
];

/** Compact selection actions; saved annotations have a separate comment editor. */
export class SelectionPopup {
	private el: HTMLElement | null = null;
	private payload: SelectionPayload | null = null;
	private editTarget: Annotation | null = null;
	private anchorRect: DOMRect | null = null;
	private styleBtns = new Map<AnnotationStyle, HTMLButtonElement>();
	private noteInput: HTMLTextAreaElement | null = null;
	private translateBtn: HTMLButtonElement | null = null;
	private resultEl: HTMLElement | null = null;
	private resultActionsEl: HTMLElement | null = null;
	private lastTranslation = "";
	private translating = false;
	private generation = 0;
	private requestAbort: AbortController | null = null;
	private cacheKey: string | null = null;
	private editDrafts = new Map<string, string>();
	private flushInkWidth: (() => void | Promise<void>) | null = null;

	constructor(private deps: SelectionPopupDeps, private getDocument: () => Document = () => document) {}

	get isVisible(): boolean {
		return this.el !== null;
	}

	contains(target: Node): boolean {
		return this.el?.contains(target) ?? false;
	}

	show(payload: SelectionPayload): void {
		// hide() clears payload/editTarget — call it BEFORE assigning state
		this.hide();
		this.payload = payload;
		this.editTarget = null;
		this.anchorRect = payload.anchorRect;
		this.cacheKey = popupCacheKey(payload);
		this.render();
	}

	showEdit(ann: Annotation, clientX: number, clientY: number, anchor?: DOMRect): void {
		this.hide();
		this.payload = null;
		this.editTarget = ann;
		this.anchorRect = anchor ?? new DOMRect(clientX, clientY, 0, 0);
		this.cacheKey = null;
		this.render();
	}

	/** the selection captured when the popup opened (survives selection loss) */
	get payloadSnapshot(): SelectionPayload | null {
		return this.payload;
	}

	focusNote(): void {
		this.noteInput?.focus();
	}

	hide(): void {
		if (this.editTarget && this.noteInput && this.noteInput.value !== (this.editTarget.note ?? "")) this.editDrafts.set(this.editTarget.id, this.noteInput.value);
		void this.flushInkWidth?.();
		this.flushInkWidth = null;
		this.requestAbort?.abort();
		this.requestAbort = null;
		this.generation++;
		this.el?.remove();
		this.el = null;
		this.payload = null;
		this.editTarget = null;
		this.lastTranslation = "";
		this.translating = false;
		this.noteInput = null;
		this.resultEl = null;
		this.resultActionsEl = null;
	}

	private render(): void {
		const anchor = this.anchorRect;
		if (!anchor) return;

		const doc = this.getDocument();
		const el = doc.body.createDiv({ cls: "pr-popup" });
		// keep the document selection alive while interacting with the popup
		el.addEventListener("mousedown", (e) => {
			const t = e.target as HTMLElement;
			if (t.tagName !== "INPUT" && t.tagName !== "TEXTAREA") e.preventDefault();
		});

		let controls = el;
		if (this.editTarget && !this.editTarget.ink) {
			el.addClass("pr-annotation-popup");
			const header = el.createDiv({ cls: "pr-annotation-popup-header" });
			const icon = header.createSpan({ cls: "pr-annotation-popup-icon" });
			setIcon(icon, this.editTarget.style === "underline" ? "underline" : "highlighter");
			icon.style.color = this.deps.getColors()[this.editTarget.color] ?? this.editTarget.color;
			header.createSpan({ text: t("页 {page}", { page: this.deps.getPageLabel?.(this.editTarget.page) ?? String(this.editTarget.page) }) });
			const options = el.createEl("details", { cls: "pr-annotation-options" });
			const toggle = options.createEl("summary", { cls: "pr-popup-btn", attr: { "aria-label": t("标注选项") } });
			setIcon(toggle, "ellipsis");
			controls = options.createDiv({ cls: "pr-annotation-options-panel" });
			options.addEventListener("toggle", () => this.position());
		}

		el.addEventListener("keydown", e => {
			if (e.key === "Escape") { e.stopPropagation(); this.hide(); this.deps.onDismiss?.(); }
		});

		// row 1: color dots
		const colorsRow = controls.createDiv({ cls: "pr-popup-colors" });
		const colors = this.deps.getColors();
		for (const key of COLOR_KEYS) {
			const dot = colorsRow.createEl("button", { cls: "pr-color-dot", attr: { type: "button" } });
			dot.addEventListener("keydown", navigateColorButtons);
			dot.style.backgroundColor = colors[key] ?? key;
			if (this.editTarget && this.editTarget.color === key) {
				dot.addClass("pr-color-dot-active");
			}
			dot.setAttr("aria-label", t("标注 {color}", { color: key }));
			dot.addEventListener("click", (e) => {
				e.stopPropagation();
				const generation = this.generation;
				void Promise.resolve(this.flushInkWidth?.()).then(() => {
					if (generation === this.generation) this.deps.applyAnnotation(key);
				}).catch(error => new Notice(String(error)));
			});
		}

		// row 2: text style picker, or rectangle stroke width
		this.styleBtns.clear();
		if (this.editTarget?.ink) {
			const id = this.editTarget.id;
			this.flushInkWidth = createInkWidthControl(el, this.editTarget.ink.width,
				(width, commit) => this.deps.setInkWidth?.(width, commit, id));
		} else {
			const stylesRow = controls.createDiv({ cls: "pr-popup-styles" });
			const currentStyle = this.editTarget?.style ?? this.deps.getStyle();
			for (const { key, icon, label } of STYLE_ORDER) {
				const btn = stylesRow.createEl("button", { cls: "pr-popup-style-btn" });
				btn.setAttr("aria-label", label);
				if (icon) setIcon(btn, icon);
				else {
					const svg = btn.createSvg("svg", { attr: {
						viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
						"stroke-width": "2", "stroke-linecap": "round",
					} });
					svg.createSvg("path", { attr: { d: "M2 14 Q 5 8 8 14 T 14 14 T 20 14 T 26 14" } });
				}
				if (key === currentStyle) btn.addClass("pr-popup-style-active");
				btn.addEventListener("click", (e) => {
					e.stopPropagation();
					this.deps.setStyle(key);
					for (const [k, b] of this.styleBtns) b.toggleClass("pr-popup-style-active", k === key);
				});
				this.styleBtns.set(key, btn);
			}
		}

		// Selection actions, or the saved annotation comment editor
		const actionsRow = el.createDiv({ cls: "pr-popup-actions" });
		const cached = this.cacheKey ? this.deps.getCached(this.cacheKey) : undefined;
		if (!this.editTarget) {
			const copyBtn = actionsRow.createEl("button", { cls: "pr-popup-btn" });
			setIcon(copyBtn, "copy");
			copyBtn.setAttr("aria-label", t("复制"));
			copyBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.deps.copySelection();
			});
			const noteBtn = actionsRow.createEl("button", { cls: "pr-popup-btn", attr: { "aria-label": t("添加批注") } });
			setIcon(noteBtn, "sticky-note");
			noteBtn.addEventListener("click", () => this.deps.onNote?.());
		}
		if (this.editTarget) {
			this.noteInput = actionsRow.createEl("textarea", {
				cls: "pr-popup-note-input",
				attr: { rows: "2", placeholder: t("添加批注…"), "aria-label": t("批注内容") },
			});
			// restore the note draft cached for this selection
			if (this.editTarget?.note) {
				this.noteInput.value = this.editTarget.note;
			} else if (cached?.noteDraft) {
				this.noteInput.value = cached.noteDraft;
			}
			if (this.editDrafts.has(this.editTarget.id)) this.noteInput.value = this.editDrafts.get(this.editTarget.id)!;
			const submit = async () => {
				const text = this.noteInput?.value.trim() ?? "";
				if (!text && !this.editTarget) return;
				const cacheKey = this.cacheKey;
				const id = this.editTarget?.id;
				if (!(await this.deps.submitNote(text))) return;
				if (id) this.editDrafts.delete(id);
				// draft consumed
				if (cacheKey) this.deps.setCached(cacheKey, { noteDraft: "" });
			};
			this.noteInput.addEventListener("input", () => {
				addBtn.disabled = !this.editTarget && !this.noteInput?.value.trim();
				if (this.editTarget && this.noteInput) this.editDrafts.set(this.editTarget.id, this.noteInput.value);
				if (this.cacheKey && this.noteInput) {
					this.deps.setCached(this.cacheKey, { noteDraft: this.noteInput.value });
				}
			});
			this.noteInput.addEventListener("keydown", (e: KeyboardEvent) => {
				if (e.key === "Escape") { e.stopPropagation(); this.hide(); this.deps.onDismiss?.(); return; }
				if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.isComposing && e.keyCode !== 229) {
					e.preventDefault();
					void submit();
				}
				e.stopPropagation();
			});
			const addBtn = actionsRow.createEl("button", { cls: "pr-popup-btn" });
			addBtn.disabled = !this.editTarget && !this.noteInput.value.trim();
			setIcon(addBtn, this.editTarget ? "check" : "plus");
			addBtn.setAttr("aria-label", this.editTarget ? t("保存批注") : t("添加批注"));
			addBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				void submit();
			});

			if (this.editTarget && this.deps.deleteAnnotation) {
				const id = this.editTarget.id;
				const del = actionsRow.createEl("button", { cls: "pr-popup-btn" });
				setIcon(del, "trash-2");
				del.setAttr("aria-label", t("删除批注"));
				del.addEventListener("click", (e) => {
					e.stopPropagation();
					this.editDrafts.delete(id);
					void this.deps.deleteAnnotation!(id);
				});
			}
		}

		// row 4: translation (only for fresh selections)
		if (!this.editTarget) {
			const trRow = el.createDiv({ cls: "pr-popup-translate pr-hidden" });
			this.translateBtn = actionsRow.createEl("button", { cls: "pr-popup-translate-btn" });
			setIcon(this.translateBtn, "languages");
			this.translateBtn.createSpan({ text: t("翻译") });
			this.translateBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				void this.runTranslate();
			});
			if (this.deps.onExplain) {
				const explain = actionsRow.createEl("button", { cls: "pr-popup-translate-btn pr-popup-explain-btn", attr: { type: "button", "aria-label": t("AI 解释") } });
				setIcon(explain, "sparkles");
				explain.createSpan({ text: t("AI 解释") });
				explain.addEventListener("click", e => {
					e.stopPropagation();
					if (this.payload) this.deps.onExplain?.(this.payload);
				});
			}
			this.resultEl = trRow.createDiv({ cls: "pr-popup-result pr-hidden" });
			this.resultActionsEl = trRow.createDiv({ cls: "pr-popup-result-actions pr-hidden" });
			const mkSmall = (label: string, onClick: () => void) => {
				const btn = this.resultActionsEl!.createEl("button", { cls: "pr-popup-small-btn" });
				btn.setText(label);
				btn.addEventListener("click", (e) => {
					e.stopPropagation();
					onClick();
				});
			};
			mkSmall(t("复制译文"), () => void this.copyTranslation());
			mkSmall(t("插入标注笔记"), () => void this.insertTranslation());
			// restore a cached translation for this selection (popup reopened)
			if (cached?.translation) {
				this.lastTranslation = cached.translation;
				this.resultEl.setText(cached.translation);
			}
		}

		doc.body.appendChild(el);
		this.el = el;
		this.position();
	}

	/** Move an open popup without replacing its input or translation state. */
	reposition(anchor: DOMRect): void {
		this.anchorRect = anchor;
		this.position();
	}

	private position(): void {
		const el = this.el;
		const anchor = this.anchorRect;
		if (!el || !anchor) return;
		const view = this.getDocument().defaultView ?? window;
		const offscreen = anchor.bottom < 0 || anchor.top > view.innerHeight || anchor.right < 0 || anchor.left > view.innerWidth;
		el.style.visibility = offscreen ? "hidden" : "";
		if (offscreen) return;
		const rect = el.getBoundingClientRect();
		// below the selection by default, flip above when out of space
		let top = anchor.bottom + 8;
		if (top + rect.height > view.innerHeight - 8) {
			top = anchor.top - rect.height - 8;
		}
		top = Math.max(4, top);
		const left = Math.max(4, Math.min(this.editTarget && anchor.width ? anchor.left + anchor.width / 2 - rect.width / 2 : anchor.left, view.innerWidth - rect.width - 4));
		el.style.top = `${top}px`;
		el.style.left = `${left}px`;
	}

	// ---- translation ----

	private async runTranslate(): Promise<void> {
		if (!this.payload || this.translating || !this.resultEl) return;
		this.resultEl.parentElement?.removeClass("pr-hidden");
		if (this.lastTranslation) {
			this.resultEl.removeClass("pr-hidden");
			this.resultActionsEl?.removeClass("pr-hidden");
			this.position();
			return;
		}
		this.translating = true;
		const requestAbort = new AbortController();
		this.requestAbort = requestAbort;
		const generation = this.generation;
		const cacheKey = this.cacheKey;
		this.lastTranslation = "";
		this.resultEl.removeClass("pr-hidden");
		this.resultEl.setText(t("翻译中…"));
		this.resultActionsEl?.addClass("pr-hidden");
		this.position();
		try {
			const out = await this.deps.translate(this.payload, (full) => {
				if (generation === this.generation && this.resultEl) {
					this.resultEl.setText(full);
					this.resultEl.scrollTop = this.resultEl.scrollHeight;
				}
			}, requestAbort.signal);
			if (generation !== this.generation) return;
			this.lastTranslation = out;
			this.resultEl?.setText(out);
			if (cacheKey) {
				this.deps.setCached(cacheKey, { translation: out });
			}
		} catch (e) {
			if (generation !== this.generation) return;
			const msg = e instanceof Error ? e.message : String(e);
			if (this.resultEl) this.resultEl.setText(msg);
			new Notice(msg);
		}
		this.translating = false;
		if (this.lastTranslation && this.resultActionsEl) {
			this.resultActionsEl.removeClass("pr-hidden");
		}
		this.position();
	}

	private async copyTranslation(): Promise<void> {
		if (!this.lastTranslation) return;
		await navigator.clipboard.writeText(this.lastTranslation);
		new Notice(t("已复制译文"));
	}

	private async insertTranslation(): Promise<void> {
		if (!this.lastTranslation) return;
		await this.deps.insertTranslation(this.lastTranslation);
	}
}
