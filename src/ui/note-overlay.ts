import { MarkdownView, MarkdownRenderer, Component } from "obsidian";

export type OverlayMode = "locked" | "reading" | "editing";

export class NoteOverlay {
	private overlayEl: HTMLElement | null = null;
	private view: MarkdownView;
	private mode: OverlayMode = "locked";
	private renderComponent: Component | null = null;
	private textarea: HTMLTextAreaElement | null = null;

	constructor(view: MarkdownView) {
		this.view = view;
	}

	getMode(): OverlayMode {
		return this.mode;
	}

	private createOverlay(...classes: string[]): HTMLElement {
		const parent = this.view.contentEl;
		// Ensure parent is a positioning context so the absolute overlay
		// stays within contentEl and doesn't cover the view header
		if (!parent.style.position) {
			parent.style.position = "relative";
		}
		const el = document.createElement("div");
		el.addClass("secrets-overlay", ...classes);
		parent.appendChild(el);
		return el;
	}

	showLocked(onUnlock: () => void): void {
		this.clear();
		this.mode = "locked";

		this.overlayEl = this.createOverlay();

		const iconEl = this.overlayEl.createDiv({
			cls: "secrets-overlay-icon",
		});
		iconEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`;

		this.overlayEl.createDiv({
			cls: "secrets-overlay-title",
			text: "This note is locked",
		});

		this.overlayEl.createDiv({
			cls: "secrets-overlay-subtitle",
			text: this.view.file?.basename ?? "Protected note",
		});

		const btn = this.overlayEl.createEl("button", {
			cls: "secrets-action-btn secrets-action-btn-primary",
			text: "Unlock",
		});
		btn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			onUnlock();
		});
	}

	showContent(decryptedContent: string): void {
		this.clear();
		this.mode = "reading";

		this.overlayEl = this.createOverlay("secrets-overlay-content");

		const contentArea = this.overlayEl.createDiv({
			cls: "secrets-content-area",
		});

		this.renderComponent = new Component();
		this.renderComponent.load();
		MarkdownRenderer.render(
			this.view.app,
			decryptedContent,
			contentArea,
			this.view.file?.path ?? "",
			this.renderComponent
		);
	}

	showEditor(decryptedContent: string): void {
		this.clear();
		this.mode = "editing";

		this.overlayEl = this.createOverlay("secrets-overlay-editor");

		const editorArea = this.overlayEl.createDiv({
			cls: "secrets-editor-area",
		});
		this.textarea = editorArea.createEl("textarea", {
			cls: "secrets-textarea",
		});
		this.textarea.value = decryptedContent;
		this.textarea.spellcheck = true;
		setTimeout(() => this.textarea?.focus(), 50);

		this.textarea.addEventListener("keydown", (e) => {
			if (e.key === "Tab") {
				e.preventDefault();
				const ta = this.textarea!;
				const start = ta.selectionStart;
				const end = ta.selectionEnd;
				ta.value =
					ta.value.substring(0, start) +
					"\t" +
					ta.value.substring(end);
				ta.selectionStart = ta.selectionEnd = start + 1;
			}
		});
	}

	getEditorValue(): string {
		return this.textarea?.value ?? "";
	}

	clear(): void {
		if (this.renderComponent) {
			this.renderComponent.unload();
			this.renderComponent = null;
		}
		if (this.overlayEl) {
			this.overlayEl.remove();
			this.overlayEl = null;
		}
		this.textarea = null;
	}

	isVisible(): boolean {
		return this.overlayEl !== null && this.overlayEl.isConnected;
	}
}
