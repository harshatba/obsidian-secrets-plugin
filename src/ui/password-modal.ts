import { App, Modal, Notice, Setting } from "obsidian";

export class PasswordSetupModal extends Modal {
	private password = "";
	private confirm = "";
	private onSubmit: (password: string) => void;
	private submitted = false;

	constructor(app: App, onSubmit: (password: string) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("secrets-modal");
		contentEl.createEl("h2", { text: "Set protection password" });
		contentEl.createEl("p", {
			text: "This password will be used to protect and unlock your notes. Choose a strong password you can remember.",
			cls: "secrets-modal-desc",
		});

		new Setting(contentEl).setName("Password").addText((text) => {
			text.inputEl.type = "password";
			text.inputEl.placeholder = "Enter password";
			text.onChange((value) => (this.password = value));
			text.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					// Move focus to confirm field
					const confirmInput = contentEl.querySelector(
						'input[placeholder="Confirm password"]'
					) as HTMLInputElement;
					if (confirmInput) confirmInput.focus();
				}
			});
			setTimeout(() => text.inputEl.focus(), 50);
		});

		new Setting(contentEl)
			.setName("Confirm password")
			.addText((text) => {
				text.inputEl.type = "password";
				text.inputEl.placeholder = "Confirm password";
				text.onChange((value) => (this.confirm = value));
				text.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") {
						this.trySubmit();
					}
				});
			});

		new Setting(contentEl).addButton((btn) => {
			btn.setButtonText("Set password")
				.setCta()
				.onClick(() => this.trySubmit());
		});
	}

	private trySubmit() {
		if (this.password.length < 4) {
			new Notice("Password must be at least 4 characters");
			return;
		}
		if (this.password !== this.confirm) {
			new Notice("Passwords do not match");
			return;
		}
		this.submitted = true;
		const pw = this.password;
		this.close();
		this.onSubmit(pw);
	}

	onClose() {
		this.contentEl.empty();
		this.password = "";
		this.confirm = "";
	}

	didSubmit(): boolean {
		return this.submitted;
	}
}

export class PasswordEntryModal extends Modal {
	private password = "";
	private onSubmit: (password: string) => void;
	private onCancel: () => void;
	private failCount: number;
	private resolved = false;

	constructor(
		app: App,
		failCount: number,
		onSubmit: (password: string) => void,
		onCancel: () => void
	) {
		super(app);
		this.failCount = failCount;
		this.onSubmit = onSubmit;
		this.onCancel = onCancel;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("secrets-modal");
		contentEl.createEl("h2", { text: "Unlock protected note" });

		if (this.failCount > 0) {
			contentEl.createEl("p", {
				text: `Incorrect password. ${this.failCount} failed attempt${this.failCount > 1 ? "s" : ""}.`,
				cls: "secrets-modal-error",
			});
		}

		new Setting(contentEl).setName("Password").addText((text) => {
			text.inputEl.type = "password";
			text.inputEl.placeholder = "Enter password";
			text.onChange((value) => (this.password = value));
			text.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					this.submit();
				}
			});
			setTimeout(() => text.inputEl.focus(), 50);
		});

		new Setting(contentEl)
			.addButton((btn) => {
				btn.setButtonText("Cancel").onClick(() => {
					this.resolved = true;
					this.close();
					this.onCancel();
				});
			})
			.addButton((btn) => {
				btn.setButtonText("Unlock")
					.setCta()
					.onClick(() => this.submit());
			});
	}

	private submit() {
		if (!this.password) {
			new Notice("Please enter a password");
			return;
		}
		this.resolved = true;
		const pw = this.password;
		this.close();
		this.onSubmit(pw);
	}

	onClose() {
		this.contentEl.empty();
		this.password = "";
		// If the modal was closed without submitting or canceling (e.g. Escape key),
		// treat it as a cancel so the Promise resolves
		if (!this.resolved) {
			this.resolved = true;
			this.onCancel();
		}
	}
}
