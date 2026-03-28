import { MarkdownView } from "obsidian";

/**
 * Lock screen overlay — shown on top of contentEl when a protected note
 * is locked. This is the ONLY overlay we use. Unlocked notes are rendered
 * natively by Obsidian (decrypted content written to the file temporarily).
 */
export class NoteOverlay {
	private overlayEl: HTMLElement | null = null;
	private view: MarkdownView;

	constructor(view: MarkdownView) {
		this.view = view;
	}

	showLocked(onUnlock: () => void): void {
		this.clear();

		const parent = this.view.contentEl;
		this.overlayEl = document.createElement("div");
		this.overlayEl.addClass("secrets-overlay");
		parent.appendChild(this.overlayEl);

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

	clear(): void {
		if (this.overlayEl) {
			this.overlayEl.remove();
			this.overlayEl = null;
		}
	}

	isVisible(): boolean {
		return this.overlayEl !== null && this.overlayEl.isConnected;
	}
}
