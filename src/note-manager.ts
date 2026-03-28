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

export class NoteManager {
	private app: App;
	private states: Map<string, ProtectedNoteState> = new Map();
	private settings: () => SecretsPluginSettings;

	constructor(app: App, getSettings: () => SecretsPluginSettings) {
		this.app = app;
		this.settings = getSettings;
	}

	isProtectedSync(file: TFile): boolean {
		// Check in-memory state first (always up-to-date)
		if (this.states.has(file.path)) return true;
		// Fall back to metadata cache
		const cache = this.app.metadataCache.getFileCache(file);
		return cache?.frontmatter?.[FRONTMATTER_KEY] === true;
	}

	async isProtected(file: TFile): Promise<boolean> {
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

	extractPayload(content: string): EncryptedPayload | null {
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

	buildEncryptedContent(payload: EncryptedPayload): string {
		const payloadStr = btoa(JSON.stringify(payload));
		return [
			"---",
			`${FRONTMATTER_KEY}: true`,
			`${FRONTMATTER_VERSION_KEY}: ${FORMAT_VERSION}`,
			"---",
			"",
			ENCRYPTED_MARKER_START,
			payloadStr,
			ENCRYPTED_MARKER_END,
			"",
		].join("\n");
	}

	async protectNote(file: TFile, password: string): Promise<void> {
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
		const encrypted = this.buildEncryptedContent(payload);
		await this.app.vault.modify(file, encrypted);

		// Keep the note unlocked with decrypted content in memory
		// so the user can keep viewing it without re-authenticating
		this.states.set(file.path, {
			path: file.path,
			unlocked: true,
			decryptedContent: content,
			unlockedAt: Date.now(),
		});

		new Notice(`"${file.basename}" is now protected`);
	}

	async unlockNote(file: TFile, password: string): Promise<boolean> {
		const content = await this.app.vault.read(file);
		const payload = this.extractPayload(content);
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
		const content = await this.app.vault.read(file);
		const payload = this.extractPayload(content);
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
			await this.app.vault.modify(file, decrypted);
			this.states.delete(file.path);
			new Notice(`"${file.basename}" is no longer protected`);
			return true;
		} catch {
			new Notice("Incorrect password");
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
		const files = this.app.vault.getMarkdownFiles();
		let count = 0;

		for (const file of files) {
			if (!this.isProtectedSync(file)) continue;

			const content = await this.app.vault.read(file);
			const payload = this.extractPayload(content);
			if (!payload) continue;

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
				const newContent = this.buildEncryptedContent(newPayload);
				await this.app.vault.modify(file, newContent);
				count++;
			} catch {
				new Notice(`Failed to re-encrypt "${file.basename}"`);
			}
		}

		return count;
	}

	handleRename(oldPath: string, newPath: string): void {
		const state = this.states.get(oldPath);
		if (state) {
			this.states.delete(oldPath);
			state.path = newPath;
			this.states.set(newPath, state);
		}
	}

	handleDelete(path: string): void {
		this.states.delete(path);
	}

	clearAll(): void {
		this.states.forEach((state) => {
			state.decryptedContent = null;
		});
		this.states.clear();
	}
}
