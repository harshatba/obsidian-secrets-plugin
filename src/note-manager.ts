import { App, TFile, Notice } from "obsidian";
import { encrypt, decrypt } from "./crypto";
import {
	EncryptedPayload,
	ProtectedNoteState,
	SecretsPluginSettings,
	ENCRYPTED_MARKER_START,
	ENCRYPTED_MARKER_END,
	FRONTMATTER_KEY,
	FRONTMATTER_VERSION_KEY,
	FORMAT_VERSION,
} from "./types";

/** Placeholder content written to the markdown file for protected notes */
function buildPlaceholder(): string {
	return [
		"---",
		`${FRONTMATTER_KEY}: true`,
		`${FRONTMATTER_VERSION_KEY}: ${FORMAT_VERSION}`,
		"---",
		"",
	].join("\n");
}

export class NoteManager {
	private app: App;
	private states: Map<string, ProtectedNoteState> = new Map();
	private settings: () => SecretsPluginSettings;
	private saveSettings: () => Promise<void>;

	constructor(
		app: App,
		getSettings: () => SecretsPluginSettings,
		saveSettings: () => Promise<void>
	) {
		this.app = app;
		this.settings = getSettings;
		this.saveSettings = saveSettings;
	}

	isProtectedSync(file: TFile): boolean {
		if (this.states.has(file.path)) return true;
		// Check plugin data
		if (this.settings().encryptedNotes[file.path]) return true;
		// Fall back to metadata cache (frontmatter)
		const cache = this.app.metadataCache.getFileCache(file);
		return cache?.frontmatter?.[FRONTMATTER_KEY] === true;
	}

	async isProtected(file: TFile): Promise<boolean> {
		if (this.settings().encryptedNotes[file.path]) return true;
		// Legacy: check for in-file encrypted markers (migration support)
		const content = await this.app.vault.read(file);
		return content.includes(ENCRYPTED_MARKER_START);
	}

	isUnlocked(path: string): boolean {
		return this.states.get(path)?.unlocked === true;
	}

	getDecryptedContent(path: string): string | null {
		return this.states.get(path)?.decryptedContent ?? null;
	}

	getState(path: string): ProtectedNoteState | undefined {
		return this.states.get(path);
	}

	getAllUnlockedPaths(): string[] {
		const paths: string[] = [];
		this.states.forEach((state, path) => {
			if (state.unlocked) paths.push(path);
		});
		return paths;
	}

	/** Legacy: extract payload from in-file markers (for migration) */
	private extractPayloadFromContent(content: string): EncryptedPayload | null {
		const startIdx = content.indexOf(ENCRYPTED_MARKER_START);
		const endIdx = content.indexOf(ENCRYPTED_MARKER_END);
		if (startIdx === -1 || endIdx === -1) return null;

		const base64 = content
			.substring(startIdx + ENCRYPTED_MARKER_START.length, endIdx)
			.trim();
		try {
			return JSON.parse(atob(base64));
		} catch {
			try {
				return JSON.parse(base64);
			} catch {
				return null;
			}
		}
	}

	/** Get the encrypted payload for a file — from plugin data or legacy in-file format */
	private async getPayload(file: TFile): Promise<EncryptedPayload | null> {
		const stored = this.settings().encryptedNotes[file.path];
		if (stored) return stored;

		// Legacy migration: read from file content
		const content = await this.app.vault.read(file);
		return this.extractPayloadFromContent(content);
	}

	async protectNote(file: TFile, password: string): Promise<void> {
		// Already protected?
		if (this.settings().encryptedNotes[file.path]) {
			new Notice("Note is already protected");
			return;
		}
		const cache = this.app.metadataCache.getFileCache(file);
		if (cache?.frontmatter?.[FRONTMATTER_KEY] === true) {
			new Notice("Note is already protected");
			return;
		}

		const content = await this.app.vault.read(file);
		if (content.includes(ENCRYPTED_MARKER_START)) {
			new Notice("Note is already protected");
			return;
		}

		const settings = this.settings();
		const payload = await encrypt(
			content,
			password,
			settings.encryptionSalt,
			settings.pbkdf2Iterations
		);

		// Store encrypted payload in plugin data
		settings.encryptedNotes[file.path] = payload;
		await this.saveSettings();

		// Replace file content with clean placeholder (nothing searchable)
		await this.app.vault.modify(file, buildPlaceholder());

		this.states.set(file.path, {
			path: file.path,
			unlocked: true,
			decryptedContent: content,
			unlockedAt: Date.now(),
		});

		new Notice(`"${file.basename}" is now protected`);
	}

	async unlockNote(file: TFile, password: string): Promise<boolean> {
		const payload = await this.getPayload(file);
		if (!payload) {
			new Notice("Could not read encrypted content");
			return false;
		}

		const settings = this.settings();
		try {
			const decrypted = await decrypt(
				payload,
				password,
				settings.encryptionSalt,
				settings.pbkdf2Iterations
			);

			// Migrate legacy in-file format to plugin data
			if (!settings.encryptedNotes[file.path]) {
				settings.encryptedNotes[file.path] = payload;
				await this.saveSettings();
				// Replace in-file encrypted blob with clean placeholder
				await this.app.vault.modify(file, buildPlaceholder());
			}

			this.states.set(file.path, {
				path: file.path,
				unlocked: true,
				decryptedContent: decrypted,
				unlockedAt: Date.now(),
			});
			return true;
		} catch {
			return false;
		}
	}

	/** Save updated encrypted content to plugin data */
	async saveEncrypted(
		file: TFile,
		payload: EncryptedPayload
	): Promise<void> {
		this.settings().encryptedNotes[file.path] = payload;
		await this.saveSettings();
	}

	lockNote(path: string): void {
		const state = this.states.get(path);
		if (state) {
			state.unlocked = false;
			state.decryptedContent = null;
			state.unlockedAt = null;
		}
	}

	lockAll(): void {
		this.states.forEach((state) => {
			state.unlocked = false;
			state.decryptedContent = null;
			state.unlockedAt = null;
		});
	}

	async unprotectNote(file: TFile, password: string): Promise<boolean> {
		const payload = await this.getPayload(file);
		if (!payload) {
			new Notice("Could not read encrypted content");
			return false;
		}

		const settings = this.settings();
		try {
			const decrypted = await decrypt(
				payload,
				password,
				settings.encryptionSalt,
				settings.pbkdf2Iterations
			);

			// Restore original content to file
			await this.app.vault.modify(file, decrypted);

			// Remove from plugin data
			delete settings.encryptedNotes[file.path];
			await this.saveSettings();

			this.states.delete(file.path);
			new Notice(`"${file.basename}" is no longer protected`);
			return true;
		} catch {
			new Notice("Failed to decrypt note");
			return false;
		}
	}

	checkAutoLock(timeoutMinutes: number): string[] {
		if (timeoutMinutes <= 0) return [];

		const now = Date.now();
		const timeoutMs = timeoutMinutes * 60 * 1000;
		const locked: string[] = [];

		this.states.forEach((state, path) => {
			if (
				state.unlocked &&
				state.unlockedAt &&
				now - state.unlockedAt > timeoutMs
			) {
				this.lockNote(path);
				locked.push(path);
			}
		});

		return locked;
	}

	async reEncryptAll(
		oldPassword: string,
		newPassword: string,
		newEncryptionSalt: string
	): Promise<number> {
		const settings = this.settings();
		let count = 0;

		for (const [path, payload] of Object.entries(settings.encryptedNotes)) {
			try {
				const decrypted = await decrypt(
					payload,
					oldPassword,
					settings.encryptionSalt,
					settings.pbkdf2Iterations
				);
				const newPayload = await encrypt(
					decrypted,
					newPassword,
					newEncryptionSalt,
					settings.pbkdf2Iterations
				);
				settings.encryptedNotes[path] = newPayload;
				count++;
			} catch {
				new Notice(`Failed to re-encrypt "${path}"`);
			}
		}

		if (count > 0) await this.saveSettings();
		return count;
	}

	handleRename(oldPath: string, newPath: string): void {
		const state = this.states.get(oldPath);
		if (state) {
			this.states.delete(oldPath);
			state.path = newPath;
			this.states.set(newPath, state);
		}

		// Update encrypted notes key
		const settings = this.settings();
		if (settings.encryptedNotes[oldPath]) {
			settings.encryptedNotes[newPath] = settings.encryptedNotes[oldPath];
			delete settings.encryptedNotes[oldPath];
			this.saveSettings();
		}
	}

	handleDelete(path: string): void {
		this.states.delete(path);
		const settings = this.settings();
		if (settings.encryptedNotes[path]) {
			delete settings.encryptedNotes[path];
			this.saveSettings();
		}
	}

	clearAll(): void {
		this.states.forEach((state) => {
			state.decryptedContent = null;
		});
		this.states.clear();
	}
}
