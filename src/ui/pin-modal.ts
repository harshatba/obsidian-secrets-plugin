import { App, Modal, Notice } from "obsidian";

type PinType = "numeric" | "alphanumeric";

export class PinSetupModal extends Modal {
	private onSubmit: (pin: string, type: PinType) => void;
	private onCancel: () => void;
	private resolved = false;
	private chosenType: PinType | null = null;
	private pin = "";

	constructor(
		app: App,
		onSubmit: (pin: string, type: PinType) => void,
		onCancel: () => void
	) {
		super(app);
		this.onSubmit = onSubmit;
		this.onCancel = onCancel;
	}

	onOpen() {
		this.modalEl.addClass("secrets-pin-modal");
		this.setTitle("Set up a passcode");
		this.showTypeScreen();
	}

	private showTypeScreen() {
		const el = this.contentEl;
		el.empty();

		const wrap = el.createDiv("secrets-pin-body");

		const numBtn = wrap.createEl("button", { text: "Numeric PIN" });
		numBtn.addClass("mod-cta", "secrets-pin-blockbtn");
		numBtn.addEventListener("click", () => {
			this.chosenType = "numeric";
			this.showInputScreen(false);
		});

		const alphaBtn = wrap.createEl("button", { text: "Alphanumeric Passcode" });
		alphaBtn.addClass("secrets-pin-blockbtn");
		alphaBtn.addEventListener("click", () => {
			this.chosenType = "alphanumeric";
			this.showInputScreen(false);
		});
	}

	private showInputScreen(isConfirm: boolean) {
		this.setTitle(isConfirm ? "Confirm passcode" : "Enter new passcode");
		const el = this.contentEl;
		el.empty();

		const isNumeric = this.chosenType === "numeric";
		const wrap = el.createDiv("secrets-pin-body");

		const input = wrap.createEl("input", {
			cls: "secrets-pin-input",
			attr: {
				type: "password",
				placeholder: isNumeric ? "4+ digit PIN" : "4+ characters",
			},
		});
		if (isNumeric) {
			input.inputMode = "numeric";
			input.pattern = "[0-9]*";
		}
		setTimeout(() => input.focus(), 50);

		const doSubmit = () => this.handleSubmit(input.value, isConfirm);

		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") doSubmit();
		});

		const btn = wrap.createEl("button", {
			text: isConfirm ? "Confirm" : "Next",
		});
		btn.addClass("mod-cta", "secrets-pin-blockbtn");
		btn.addEventListener("click", doSubmit);
	}

	private handleSubmit(value: string, isConfirm: boolean) {
		if (value.length < 4) {
			new Notice("Must be at least 4 characters");
			return;
		}
		if (this.chosenType === "numeric" && !/^\d+$/.test(value)) {
			new Notice("PIN must contain only digits");
			return;
		}
		if (!isConfirm) {
			this.pin = value;
			this.showInputScreen(true);
			return;
		}
		if (value !== this.pin) {
			new Notice("Passcodes don't match");
			this.showInputScreen(true);
			return;
		}
		this.resolved = true;
		this.close();
		this.onSubmit(this.pin, this.chosenType!);
	}

	onClose() {
		this.contentEl.empty();
		if (!this.resolved) {
			this.resolved = true;
			this.onCancel();
		}
	}
}

export class PinEntryModal extends Modal {
	private pinType: PinType;
	private onSubmit: (pin: string) => void;
	private onCancel: () => void;
	private resolved = false;
	private failCount: number;

	constructor(
		app: App,
		pinType: PinType,
		failCount: number,
		onSubmit: (pin: string) => void,
		onCancel: () => void
	) {
		super(app);
		this.pinType = pinType;
		this.failCount = failCount;
		this.onSubmit = onSubmit;
		this.onCancel = onCancel;
	}

	onOpen() {
		this.modalEl.addClass("secrets-pin-modal");
		this.setTitle("Enter Passcode");
		const el = this.contentEl;

		if (this.failCount > 0) {
			el.createEl("p", {
				text: `Incorrect passcode. ${this.failCount} failed attempt${this.failCount > 1 ? "s" : ""}.`,
				cls: "secrets-pin-error",
			});
		}

		const isNumeric = this.pinType === "numeric";
		const wrap = el.createDiv("secrets-pin-body");

		const input = wrap.createEl("input", {
			cls: "secrets-pin-input",
			attr: {
				type: "password",
				placeholder: isNumeric ? "Enter PIN" : "Enter passcode",
			},
		});
		if (isNumeric) {
			input.inputMode = "numeric";
			input.pattern = "[0-9]*";
		}
		setTimeout(() => input.focus(), 50);

		const doSubmit = () => {
			if (!input.value) {
				new Notice("Please enter your passcode");
				return;
			}
			this.resolved = true;
			const val = input.value;
			this.close();
			this.onSubmit(val);
		};

		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") doSubmit();
		});

		const row = wrap.createDiv("secrets-pin-row");

		const cancelBtn = row.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => {
			this.resolved = true;
			this.close();
			this.onCancel();
		});

		const unlockBtn = row.createEl("button", { text: "Unlock" });
		unlockBtn.addClass("mod-cta");
		unlockBtn.addEventListener("click", doSubmit);
	}

	onClose() {
		this.contentEl.empty();
		if (!this.resolved) {
			this.resolved = true;
			this.onCancel();
		}
	}
}
