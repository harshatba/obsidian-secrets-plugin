import { MarkdownView } from "obsidian";

export class LockScreen {
	private overlayEl: HTMLElement | null = null;
	private view: MarkdownView;

	constructor(view: MarkdownView) {
		this.view = view;
	}

	updateView(view: MarkdownView): void {
		this.view = view;
	}

	show(onUnlock: () => void): void {
		this.hide();

		// Use contentEl — it has position:relative in Obsidian's CSS
		const parent = this.view.contentEl;

		// Create a full-coverage overlay that sits on top of everything
		this.overlayEl = document.createElement("div");
		this.overlayEl.addClass("secrets-lock-screen");
		parent.appendChild(this.overlayEl);

		const iconEl = this.overlayEl.createDiv({ cls: "secrets-lock-icon" });
		iconEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`;

		this.overlayEl.createDiv({
			cls: "secrets-lock-title",
			text: "This note is locked",
		});

		this.overlayEl.createDiv({
			cls: "secrets-lock-subtitle",
			text: this.view.file?.basename ?? "Protected note",
		});

		const btn = this.overlayEl.createEl("button", {
			cls: "secrets-unlock-btn",
			text: "Unlock",
		});
		btn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			onUnlock();
		});
	}

	hide(): void {
		if (this.overlayEl) {
			this.overlayEl.remove();
			this.overlayEl = null;
		}
	}

	isVisible(): boolean {
		return this.overlayEl !== null && this.overlayEl.isConnected;
	}
}
