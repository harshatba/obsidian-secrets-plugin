import { App, Modal, Setting } from "obsidian";

export class ProtectConfirmModal extends Modal {
	private noteName: string;
	private onConfirm: () => void;

	constructor(app: App, noteName: string, onConfirm: () => void) {
		super(app);
		this.noteName = noteName;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("secrets-modal");
		contentEl.createEl("h2", { text: "Protect note" });
		contentEl.createEl("p", {
			text: `"${this.noteName}" will be encrypted and locked. You'll need your passcode or Touch ID to view it.`,
		});

		new Setting(contentEl)
			.addButton((btn) => {
				btn.setButtonText("Cancel").onClick(() => this.close());
			})
			.addButton((btn) => {
				btn.setButtonText("Protect")
					.setCta()
					.onClick(() => {
						this.close();
						this.onConfirm();
					});
			});
	}

	onClose() {
		this.contentEl.empty();
	}
}

export class UnprotectConfirmModal extends Modal {
	private noteName: string;
	private onConfirm: () => void;

	constructor(app: App, noteName: string, onConfirm: () => void) {
		super(app);
		this.noteName = noteName;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("secrets-modal");
		contentEl.createEl("h2", { text: "Remove protection" });
		contentEl.createEl("p", {
			text: `"${this.noteName}" will be permanently decrypted and no longer protected. Anyone with access to the vault can read it.`,
		});

		new Setting(contentEl)
			.addButton((btn) => {
				btn.setButtonText("Cancel").onClick(() => this.close());
			})
			.addButton((btn) => {
				btn.setButtonText("Remove protection")
					.setWarning()
					.onClick(() => {
						this.close();
						this.onConfirm();
					});
			});
	}

	onClose() {
		this.contentEl.empty();
	}
}
