import {
	MarkdownView,
	Notice,
	Plugin,
	TFile,
	TAbstractFile,
	WorkspaceLeaf,
	Menu,
} from "obsidian";
import { NoteManager } from "./note-manager";
import { AuthService } from "./auth";
import { SecretsSettingTab } from "./settings";
import { NoteOverlay } from "./ui/note-overlay";
import {
	ProtectConfirmModal,
	UnprotectConfirmModal,
} from "./ui/protect-modal";
import { generateSalt } from "./crypto";
import { SecretsPluginSettings, DEFAULT_SETTINGS } from "./types";

export default class SecretsPlugin extends Plugin {
	settings: SecretsPluginSettings = DEFAULT_SETTINGS;
	noteManager: NoteManager;
	authService: AuthService;

	private overlays: Map<string, NoteOverlay> = new Map();
	private viewActions: HTMLElement[] = [];
	private statusBarEl: HTMLElement | null = null;
	private cachedKey: string | null = null;
	private cachedKeyAt = 0;
	private authInProgress = false;
	readonly AUTH_CACHE_MS = 30000;

	async onload() {
		await this.loadSettings();

		this.noteManager = new NoteManager(
			this.app,
			() => this.settings,
			() => this.saveSettings()
		);
		this.authService = new AuthService(
			this.app,
			() => this.settings,
			() => this.saveSettings()
		);

		this.addSettingTab(new SecretsSettingTab(this.app, this));

		this.statusBarEl = this.addStatusBarItem();

		// Commands
		this.addCommand({
			id: "protect-note",
			name: "Protect current note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (this.noteManager.isProtectedSync(file)) return false;
				if (!checking) this.protectCurrentNote();
				return true;
			},
		});

		this.addCommand({
			id: "unprotect-note",
			name: "Remove protection from current note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!this.noteManager.isProtectedSync(file)) return false;
				if (!checking) this.unprotectCurrentNote();
				return true;
			},
		});

		this.addCommand({
			id: "unlock-note",
			name: "Unlock current note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!this.noteManager.isProtectedSync(file)) return false;
				if (this.noteManager.isUnlocked(file.path)) return false;
				if (!checking) this.unlockCurrentNote();
				return true;
			},
		});

		this.addCommand({
			id: "lock-note",
			name: "Lock current note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!this.noteManager.isUnlocked(file.path)) return false;
				if (!checking) this.lockNoteByFile(file);
				return true;
			},
		});

		this.addCommand({
			id: "lock-all",
			name: "Lock all protected notes",
			callback: () => this.lockAllNotes(),
		});

		this.addRibbonIcon("lock", "Lock all protected notes", () => {
			this.lockAllNotes();
		});

		// File menu
		this.registerEvent(
			this.app.workspace.on(
				"file-menu",
				(menu: Menu, file: TAbstractFile) => {
					if (!(file instanceof TFile) || file.extension !== "md")
						return;
					const isProtected =
						this.noteManager.isProtectedSync(file);
					if (isProtected) {
						const isUnlocked = this.noteManager.isUnlocked(
							file.path
						);
						if (isUnlocked) {
							menu.addItem((item) =>
								item
									.setTitle("Lock note")
									.setIcon("lock")
									.onClick(() => this.lockNoteByFile(file))
							);
						} else {
							menu.addItem((item) =>
								item
									.setTitle("Unlock note")
									.setIcon("unlock")
									.onClick(() => this.unlockNote(file))
							);
						}
						menu.addItem((item) =>
							item
								.setTitle("Remove protection")
								.setIcon("shield-off")
								.onClick(() => this.unprotectNote(file))
						);
					} else {
						menu.addItem((item) =>
							item
								.setTitle("Protect note")
								.setIcon("shield")
								.onClick(() => this.protectNote(file))
						);
					}
				}
			)
		);

		// Show lock overlay when switching to a locked note
		this.registerEvent(
			this.app.workspace.on(
				"active-leaf-change",
				(leaf: WorkspaceLeaf | null) => {
					if (leaf) this.handleLeafChange(leaf);
				}
			)
		);

		this.registerEvent(
			this.app.workspace.on("file-open", () => {
				setTimeout(() => {
					const leaf = this.app.workspace.getMostRecentLeaf();
					if (leaf) this.handleLeafChange(leaf);
				}, 150);
			})
		);

		// Track renames/deletes
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile) {
					this.noteManager.handleRename(oldPath, file.path);
					const ov = this.overlays.get(oldPath);
					if (ov) {
						this.overlays.delete(oldPath);
						this.overlays.set(file.path, ov);
					}
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFile) {
					this.noteManager.handleDelete(file.path);
					this.clearOverlay(file.path);
				}
			})
		);

		// Auto-lock
		const interval = window.setInterval(async () => {
			const expired = this.noteManager.checkAutoLock(
				this.settings.autoLockTimeoutMinutes
			);
			for (const path of expired) {
				const file = this.app.vault.getAbstractFileByPath(path);
				if (file instanceof TFile) {
					await this.lockNoteByFile(file);
				}
			}
		}, 15000);
		this.registerInterval(interval);

		this.registerDomEvent(window, "blur", () => {
			if (this.settings.lockOnBlur) this.lockAllNotes();
		});

		this.app.workspace.onLayoutReady(() => {
			const leaf = this.app.workspace.getMostRecentLeaf();
			if (leaf) this.handleLeafChange(leaf);
		});
	}

	async onunload() {
		// Lock all notes on unload so decrypted content doesn't persist on disk
		const key = this.cachedKey;
		if (key) {
			await this.noteManager.lockAll(key);
		}
		this.overlays.forEach((ov) => ov.clear());
		this.overlays.clear();
		this.viewActions.forEach((el) => el.remove());
		this.noteManager.clearAll();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
		if (!this.settings.encryptedNotes) {
			this.settings.encryptedNotes = {};
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// ─── View Management ───

	private async handleLeafChange(leaf: WorkspaceLeaf): Promise<void> {
		if (this.authInProgress) return;

		const view = leaf.view;
		if (!(view instanceof MarkdownView)) return;
		const file = view.file;
		if (!file) return;

		// Clear stale overlays from this view
		this.clearOverlaysOnView(view);

		let isProtected = this.noteManager.isProtectedSync(file);
		if (!isProtected) {
			isProtected = await this.noteManager.isProtected(file);
		}

		if (isProtected && !this.noteManager.isUnlocked(file.path)) {
			this.showLockOverlay(view, file);
		} else {
			this.clearOverlay(file.path);
		}

		this.setViewActions(view, file, isProtected);
		this.updateStatusBar();
	}

	private clearOverlaysOnView(view: MarkdownView): void {
		view.contentEl
			.querySelectorAll(".secrets-overlay")
			.forEach((el) => el.remove());
		for (const [path, ov] of this.overlays) {
			if (!ov.isVisible()) {
				ov.clear();
				this.overlays.delete(path);
			}
		}
	}

	private clearViewActions(): void {
		this.viewActions.forEach((el) => el.remove());
		this.viewActions = [];
	}

	private setViewActions(
		view: MarkdownView,
		file: TFile,
		isProtected: boolean
	): void {
		this.clearViewActions();

		if (!isProtected) {
			this.viewActions.push(
				view.addAction("lock", "Protect note", () =>
					this.protectNote(file)
				)
			);
			return;
		}

		const isUnlocked = this.noteManager.isUnlocked(file.path);

		if (isUnlocked) {
			// Unlocked: lock and remove protection
			this.viewActions.push(
				view.addAction("lock", "Lock", () =>
					this.lockNoteByFile(file)
				)
			);
			this.viewActions.push(
				view.addAction("shield-off", "Remove protection", () =>
					this.unprotectNote(file)
				)
			);
		} else {
			// Locked: unlock
			this.viewActions.push(
				view.addAction("unlock", "Unlock note", () =>
					this.unlockNote(file)
				)
			);
		}
	}

	private showLockOverlay(view: MarkdownView, file: TFile): void {
		this.clearOverlay(file.path);
		const ov = new NoteOverlay(view);
		this.overlays.set(file.path, ov);
		ov.showLocked(() => this.unlockNote(file));
	}

	private clearOverlay(path: string): void {
		const ov = this.overlays.get(path);
		if (ov) {
			ov.clear();
			this.overlays.delete(path);
		}
	}

	// ─── Authentication ───

	private async authenticateForAction(
		reason: string
	): Promise<string | null> {
		if (
			this.cachedKey &&
			Date.now() - this.cachedKeyAt < this.AUTH_CACHE_MS
		) {
			return this.cachedKey;
		}
		this.authInProgress = true;
		try {
			const key = await this.authService.authenticate(reason);
			if (key) {
				this.cachedKey = key;
				this.cachedKeyAt = Date.now();
			}
			return key;
		} finally {
			this.authInProgress = false;
		}
	}

	private cacheKey(): void {
		const key = this.authService.getEncryptionKey();
		if (key) {
			this.cachedKey = key;
			this.cachedKeyAt = Date.now();
		}
	}

	// ─── Note Actions ───

	private async protectNote(file: TFile): Promise<void> {
		new ProtectConfirmModal(this.app, file.basename, async () => {
			await this.doProtect(file);
		}).open();
	}

	private async doProtect(file: TFile): Promise<void> {
		if (!this.authService.hasPin()) {
			this.authInProgress = true;
			try {
				const pinSet = await this.authService.setupPin();
				if (!pinSet) return;
			} finally {
				this.authInProgress = false;
			}

			const keyReady = await this.authService.ensureEncryptionKey();
			if (!keyReady) {
				new Notice("Failed to set up encryption.");
				return;
			}
			if (!this.settings.encryptionSalt) {
				this.settings.encryptionSalt = generateSalt();
				await this.saveSettings();
			}
			this.cacheKey();
		} else {
			const keyReady = await this.authService.ensureEncryptionKey();
			if (!keyReady) {
				new Notice("Failed to set up encryption.");
				return;
			}
			if (!this.settings.encryptionSalt) {
				this.settings.encryptionSalt = generateSalt();
				await this.saveSettings();
			}
			const key = await this.authenticateForAction(
				"Authenticate to protect note"
			);
			if (!key) return;
		}

		const key = this.cachedKey;
		if (!key) return;

		try {
			await this.noteManager.protectNote(file, key);
			// File content stays as-is (note is unlocked after protect)
			// Obsidian continues rendering it natively
			const view =
				this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view && view.file?.path === file.path) {
				this.setViewActions(view, file, true);
			}
			this.updateStatusBar();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error("Secrets: protect failed", e);
			new Notice(`Failed to protect note: ${msg}`);
		}
	}

	private async protectCurrentNote(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (file) await this.protectNote(file);
	}

	private async unlockNote(file: TFile): Promise<void> {
		const key = await this.authenticateForAction(
			"Unlock protected note"
		);
		if (!key) {
			const view =
				this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view && view.file?.path === file.path) {
				if (!this.overlays.get(file.path)?.isVisible()) {
					this.showLockOverlay(view, file);
				}
			}
			return;
		}

		const success = await this.noteManager.unlockNote(file, key);
		if (success) {
			// Decrypted content is now in the file — Obsidian renders it natively.
			// Just clear the lock overlay and update actions.
			this.clearOverlay(file.path);
			const view =
				this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view && view.file?.path === file.path) {
				this.setViewActions(view, file, true);
			}
			this.updateStatusBar();
		} else {
			new Notice("Failed to unlock note.");
		}
	}

	private async unlockCurrentNote(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (file) await this.unlockNote(file);
	}

	private async unprotectNote(file: TFile): Promise<void> {
		new UnprotectConfirmModal(this.app, file.basename, async () => {
			const key = await this.authenticateForAction(
				"Remove note protection"
			);
			if (!key) return;
			await this.noteManager.unprotectNote(file, key);
			this.clearOverlay(file.path);
			const view =
				this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view && view.file?.path === file.path) {
				this.setViewActions(view, file, false);
			}
			this.updateStatusBar();
		}).open();
	}

	private async unprotectCurrentNote(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (file) await this.unprotectNote(file);
	}

	private async lockNoteByFile(file: TFile): Promise<void> {
		const key = this.cachedKey;
		if (!key) {
			// Need to re-authenticate to get the key for re-encryption
			const authKey = await this.authenticateForAction("Lock note");
			if (!authKey) return;
		}

		await this.noteManager.lockNote(file, this.cachedKey!);
		this.cachedKey = null;
		this.cachedKeyAt = 0;

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view && view.file?.path === file.path) {
			this.showLockOverlay(view, file);
			this.setViewActions(view, file, true);
		}
		this.updateStatusBar();
		new Notice(`"${file.basename}" locked`);
	}

	private async lockAllNotes(): Promise<void> {
		const key = this.cachedKey;
		if (!key) return; // Can't lock without key to re-encrypt

		await this.noteManager.lockAll(key);
		this.overlays.forEach((ov) => ov.clear());
		this.overlays.clear();
		this.cachedKey = null;
		this.cachedKeyAt = 0;

		const leaf = this.app.workspace.getMostRecentLeaf();
		if (leaf) this.handleLeafChange(leaf);

		new Notice("All protected notes locked");
	}

	private async updateStatusBar(): Promise<void> {
		if (!this.statusBarEl) return;
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			this.statusBarEl.empty();
			return;
		}
		let isProtected = this.noteManager.isProtectedSync(file);
		if (!isProtected) {
			isProtected = await this.noteManager.isProtected(file);
		}
		if (isProtected) {
			const unlocked = this.noteManager.isUnlocked(file.path);
			this.statusBarEl.setText(unlocked ? "Unlocked" : "Locked");
		} else {
			this.statusBarEl.empty();
		}
	}
}
