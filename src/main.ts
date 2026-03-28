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
import { encrypt, generateSalt } from "./crypto";
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

		// Show overlay when switching notes
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
		const interval = window.setInterval(() => {
			const locked = this.noteManager.checkAutoLock(
				this.settings.autoLockTimeoutMinutes
			);
			if (locked.length > 0) {
				const leaf = this.app.workspace.getMostRecentLeaf();
				if (leaf) this.handleLeafChange(leaf);
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

	onunload() {
		this.noteManager.clearAll();
		this.overlays.forEach((ov) => ov.clear());
		this.overlays.clear();
		this.viewActions.forEach((el) => el.remove());
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
		// Ensure encryptedNotes is always an object (older data.json may lack it)
		if (!this.settings.encryptedNotes) {
			this.settings.encryptedNotes = {};
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// ─── Overlay Management ───

	private async handleLeafChange(leaf: WorkspaceLeaf): Promise<void> {
		// Don't touch overlays while auth modal is open — it would
		// remove the lock overlay and expose content underneath
		if (this.authInProgress) return;

		const view = leaf.view;
		if (!(view instanceof MarkdownView)) return;
		const file = view.file;
		if (!file) return;

		// Clear any stale overlays left on this view from a previous file
		this.clearOverlaysOnView(view);

		let isProtected = this.noteManager.isProtectedSync(file);
		if (!isProtected) {
			isProtected = await this.noteManager.isProtected(file);
		}

		if (isProtected) {
			if (this.noteManager.isUnlocked(file.path)) {
				this.showContentOverlay(view, file);
			} else {
				this.showLockOverlay(view, file);
			}
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
		const overlay = this.overlays.get(file.path);
		const isEditing = overlay?.getMode() === "editing";

		if (isEditing) {
			// Editor mode: save + cancel
			this.viewActions.push(
				view.addAction("x", "Cancel", () => {
					this.showContentOverlay(view, file);
				})
			);
			this.viewActions.push(
				view.addAction("check", "Save", async () => {
					const content = overlay!.getEditorValue();
					await this.saveEditedContent(file, content);
					this.showContentOverlay(view, file);
				})
			);
		} else if (isUnlocked) {
			// Reading mode: edit, lock, remove protection
			this.viewActions.push(
				view.addAction("pencil", "Edit", () =>
					this.editNote(view, file)
				)
			);
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

	private showContentOverlay(view: MarkdownView, file: TFile): void {
		const decrypted = this.noteManager.getDecryptedContent(file.path);
		if (!decrypted && decrypted !== "") return;

		this.clearOverlay(file.path);
		const ov = new NoteOverlay(view);
		this.overlays.set(file.path, ov);
		ov.showContent(decrypted!);
		this.setViewActions(view, file, true);
	}

	private editNote(view: MarkdownView, file: TFile): void {
		const decrypted = this.noteManager.getDecryptedContent(file.path);
		if (decrypted === null) return;

		this.clearOverlay(file.path);
		const ov = new NoteOverlay(view);
		this.overlays.set(file.path, ov);
		ov.showEditor(decrypted);
		this.setViewActions(view, file, true);
	}

	private async saveEditedContent(
		file: TFile,
		content: string
	): Promise<void> {
		const state = this.noteManager.getState(file.path);
		if (state) {
			state.decryptedContent = content;
			state.unlockedAt = Date.now();
		}
		try {
			const key = this.cachedKey;
			if (!key) return;
			const payload = await encrypt(
				content,
				key,
				this.settings.encryptionSalt,
				this.settings.pbkdf2Iterations
			);
			await this.noteManager.saveEncrypted(file, payload);
		} catch (e) {
			console.error("Secrets: failed to save encrypted content", e);
			new Notice("Failed to save encrypted content");
		}
	}

	private clearOverlay(path: string): void {
		const ov = this.overlays.get(path);
		if (ov) {
			ov.clear();
			this.overlays.delete(path);
		}
	}

	// ─── Authentication ───

	/**
	 * Authenticate and return encryption key.
	 * Sets authInProgress to prevent handleLeafChange from
	 * removing overlays while a modal is open.
	 */
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
		// Step 1: Confirm the user wants to protect
		new ProtectConfirmModal(this.app, file.basename, async () => {
			await this.doProtect(file);
		}).open();
	}

	private async doProtect(file: TFile): Promise<void> {
		// Step 2: If no PIN, set one up (first time)
		// After setup, cache the key so we don't prompt again
		if (!this.authService.hasPin()) {
			this.authInProgress = true;
			try {
				const pinSet = await this.authService.setupPin();
				if (!pinSet) return;
			} finally {
				this.authInProgress = false;
			}

			// Ensure encryption key exists
			const keyReady = await this.authService.ensureEncryptionKey();
			if (!keyReady) {
				new Notice("Failed to set up encryption.");
				return;
			}
			if (!this.settings.encryptionSalt) {
				this.settings.encryptionSalt = generateSalt();
				await this.saveSettings();
			}

			// Cache key immediately — user just proved identity by setting PIN
			this.cacheKey();
		} else {
			// Ensure encryption key + salt exist
			const keyReady = await this.authService.ensureEncryptionKey();
			if (!keyReady) {
				new Notice("Failed to set up encryption.");
				return;
			}
			if (!this.settings.encryptionSalt) {
				this.settings.encryptionSalt = generateSalt();
				await this.saveSettings();
			}

			// Step 3: Authenticate (Touch ID or PIN)
			const key = await this.authenticateForAction(
				"Authenticate to protect note"
			);
			if (!key) return;
		}

		// Step 4: Encrypt
		const key = this.cachedKey;
		if (!key) return;

		try {
			await this.noteManager.protectNote(file, key);
			const view =
				this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view && view.file?.path === file.path) {
				this.showContentOverlay(view, file);
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
			// Auth cancelled — ensure lock overlay is still showing
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
			const view =
				this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view && view.file?.path === file.path) {
				this.showContentOverlay(view, file);
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

	private lockNoteByFile(file: TFile): void {
		this.noteManager.lockNote(file.path);
		this.clearOverlay(file.path);
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view && view.file?.path === file.path) {
			this.showLockOverlay(view, file);
		}
		this.updateStatusBar();
		new Notice(`"${file.basename}" locked`);
	}

	private lockAllNotes(): void {
		this.noteManager.lockAll();
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
