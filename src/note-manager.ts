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

/** Placeholder content written to the markdown file for locked notes */
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
		if (this.settings().encryptedNotes[file.path]) return true;
		const cache = this.app.metadataCache.getFileCache(file);
		return cache?.frontmatter?.[FRONTMATTER_KEY] === true;
	}

	async isProtected(file: TFile): Promise<boolean> {
		if (this.settings().encryptedNotes[file.path]) return true;
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

	private async getPayload(file: TFile): Promise<EncryptedPayload | null> {
		const stored = this.settings().encryptedNotes[file.path];
		if (stored) return stored;

		const content = await this.app.vault.read(file);
		return this.extractPayloadFromContent(content);
	}

	async protectNote(file: TFile, password: string): Promise<void> {
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

		// File keeps the original content (note is unlocked after protect).
		// The file will be replaced with placeholder when the user locks it.
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
			}

			// Write decrypted content to file so Obsidian renders it natively
			await this.app.vault.modify(file, decrypted);

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

	/**
	 * Lock a note: re-encrypt current file content, store in plugin data,
	 * then replace file with placeholder.
	 */
	async lockNote(file: TFile, password: string): Promise<void> {
		const state = this.states.get(file.path);
		if (!state?.unlocked) return;

		// Read the current file content (user may have edited it)
		const currentContent = await this.app.vault.read(file);

		// Re-encrypt with current content
		const settings = this.settings();
		const payload = await encrypt(
			currentContent,
			password,
			settings.encryptionSalt,
			settings.pbkdf2Iterations
		);
		settings.encryptedNotes[file.path] = payload;
		await this.saveSettings();

		// Replace file with placeholder
		await this.app.vault.modify(file, buildPlaceholder());

		state.unlocked = false;
		state.decryptedContent = null;
		state.unlockedAt = null;
	}

	/**
	 * Lock all notes: re-encrypt each unlocked note and write placeholders.
	 */
	async lockAll(password: string): Promise<void> {
		for (const [path, state] of this.states) {
			if (!state.unlocked) continue;

			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) continue;

			try {
				await this.lockNote(file, password);
			} catch (e) {
				console.error(`Secrets: failed to lock ${path}`, e);
			}
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

			// Write original content to file (it may already be there if unlocked)
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
		const expired: string[] = [];

		this.states.forEach((state, path) => {
			if (
				state.unlocked &&
				state.unlockedAt &&
				now - state.unlockedAt > timeoutMs
			) {
				expired.push(path);
			}
		});

		return expired;
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
