import { describe, it, expect, beforeEach } from "vitest";
import { App, TFile, Platform } from "obsidian";
import { NoteManager } from "../src/note-manager";
import { AuthService } from "../src/auth";
import { SecretsPluginSettings, DEFAULT_SETTINGS } from "../src/types";
import { generateSalt } from "../src/crypto";

/**
 * Simulates the plugin's state machine (auth caching, lock/unlock flows).
 * Tests the logic paths from main.ts without the full Plugin class.
 */

const PASSWORD = "test-key";
const ITERATIONS = 1000;

class PluginSimulator {
	settings: SecretsPluginSettings;
	noteManager: NoteManager;
	authService: AuthService;
	cachedKey: string | null = null;
	cachedKeyAt = 0;
	readonly AUTH_CACHE_MS = 30000;

	authPrompted = false;

	constructor() {
		this.settings = {
			...DEFAULT_SETTINGS,
			encryptionSalt: generateSalt(),
			pbkdf2Iterations: ITERATIONS,
			encryptedNotes: {},
		};

		const app = new App();
		(Platform as any).isMacOS = false;

		this.noteManager = new NoteManager(
			app,
			() => this.settings,
			async () => {}
		);
		this.authService = new AuthService(
			app,
			() => this.settings,
			async () => {}
		);
	}

	async authenticateForAction(_reason: string): Promise<string | null> {
		if (this.cachedKey && Date.now() - this.cachedKeyAt < this.AUTH_CACHE_MS) {
			return this.cachedKey;
		}
		this.authPrompted = true;
		const key = this.authService.getEncryptionKey();
		if (key) {
			this.cachedKey = key;
			this.cachedKeyAt = Date.now();
		}
		return key;
	}

	cacheKey(): void {
		const key = this.authService.getEncryptionKey();
		if (key) {
			this.cachedKey = key;
			this.cachedKeyAt = Date.now();
		}
	}

	async doProtect(file: TFile): Promise<boolean> {
		if (!this.authService.hasPin()) {
			const salt = generateSalt();
			const { hashPassword } = await import("../src/crypto");
			const hash = await hashPassword("1234", salt, ITERATIONS);
			this.settings.pinHash = hash;
			this.settings.pinSalt = salt;
			this.settings.pinType = "numeric";

			await this.authService.ensureEncryptionKey();
			if (!this.settings.encryptionSalt) {
				this.settings.encryptionSalt = generateSalt();
			}
			this.cacheKey();
		} else {
			await this.authService.ensureEncryptionKey();
			if (!this.settings.encryptionSalt) {
				this.settings.encryptionSalt = generateSalt();
			}
			const key = await this.authenticateForAction("protect");
			if (!key) return false;
		}

		const key = this.cachedKey;
		if (!key) return false;

		(this.noteManager as any).app.vault._set(file.path, "test content");
		await this.noteManager.protectNote(file, key);
		return true;
	}

	async lockNoteByFile(file: TFile): Promise<void> {
		const key = this.cachedKey;
		if (!key) return;
		await this.noteManager.lockNote(file, key);
		this.cachedKey = null;
		this.cachedKeyAt = 0;
	}

	async lockAllNotes(): Promise<void> {
		const key = this.cachedKey;
		if (!key) return;
		await this.noteManager.lockAll(key);
		this.cachedKey = null;
		this.cachedKeyAt = 0;
	}

	async unlockNote(file: TFile): Promise<boolean> {
		this.authPrompted = false;
		const key = await this.authenticateForAction("unlock");
		if (!key) return false;

		return this.noteManager.unlockNote(file, key);
	}
}

describe("Plugin flows", () => {
	let sim: PluginSimulator;
	const file = new TFile("test.md");

	beforeEach(() => {
		sim = new PluginSimulator();
	});

	// ─── THE BUG: lock must clear auth cache ───

	describe("protect → lock → unlock requires auth", () => {
		it("clearing cache on lock forces re-authentication on unlock", async () => {
			await sim.doProtect(file);
			expect(sim.cachedKey).not.toBeNull();

			await sim.lockNoteByFile(file);
			expect(sim.cachedKey).toBeNull();
			expect(sim.cachedKeyAt).toBe(0);

			sim.authPrompted = false;
			await sim.unlockNote(file);
			expect(sim.authPrompted).toBe(true);
		});
	});

	// ─── First-time protect: PIN setup, no re-auth ───

	describe("first-time protect flow", () => {
		it("sets up PIN and caches key without re-prompting", async () => {
			expect(sim.authService.hasPin()).toBe(false);

			sim.authPrompted = false;
			await sim.doProtect(file);

			expect(sim.authService.hasPin()).toBe(true);
			expect(sim.cachedKey).not.toBeNull();
			expect(sim.noteManager.isUnlocked("test.md")).toBe(true);
		});
	});

	// ─── Protect with existing PIN requires auth ───

	describe("protect with existing PIN", () => {
		it("requires authentication", async () => {
			await sim.doProtect(file);
			await sim.lockNoteByFile(file);

			const file2 = new TFile("second.md");
			(sim.noteManager as any).app.vault._set("second.md", "second content");

			sim.authPrompted = false;
			await sim.doProtect(file2);

			expect(sim.authPrompted).toBe(true);
		});
	});

	// ─── Auth cache timing ───

	describe("auth cache", () => {
		it("skips auth within cache window", async () => {
			await sim.doProtect(file);

			sim.authPrompted = false;
			await sim.authenticateForAction("some action");

			expect(sim.authPrompted).toBe(false);
		});

		it("re-prompts after cache expires", async () => {
			await sim.doProtect(file);

			sim.cachedKeyAt = Date.now() - 31000;

			sim.authPrompted = false;
			await sim.authenticateForAction("some action");

			expect(sim.authPrompted).toBe(true);
		});
	});

	// ─── Lock all clears cache ───

	describe("lockAllNotes", () => {
		it("clears auth cache", async () => {
			await sim.doProtect(file);
			expect(sim.cachedKey).not.toBeNull();

			await sim.lockAllNotes();

			expect(sim.cachedKey).toBeNull();
			expect(sim.cachedKeyAt).toBe(0);
		});

		it("locks all notes", async () => {
			const file2 = new TFile("second.md");
			(sim.noteManager as any).app.vault._set("second.md", "content");
			await sim.doProtect(file);
			await sim.doProtect(file2);

			await sim.lockAllNotes();

			expect(sim.noteManager.isUnlocked("test.md")).toBe(false);
			expect(sim.noteManager.isUnlocked("second.md")).toBe(false);
		});
	});

	// ─── Encrypt → decrypt roundtrip through NoteManager ───

	describe("end-to-end encrypt/decrypt", () => {
		it("content survives protect → lock → unlock cycle", async () => {
			(sim.noteManager as any).app.vault._set("test.md", "My secret note");

			await sim.authService.ensureEncryptionKey();
			if (!sim.settings.encryptionSalt) {
				sim.settings.encryptionSalt = generateSalt();
			}
			sim.cacheKey();
			await sim.noteManager.protectNote(file, sim.cachedKey!);

			// File still has original content (unlocked after protect)
			expect((sim.noteManager as any).app.vault._get("test.md")).toBe("My secret note");

			// Lock — file gets placeholder
			await sim.noteManager.lockNote(file, sim.cachedKey!);
			expect((sim.noteManager as any).app.vault._get("test.md")).not.toContain("My secret note");

			// Unlock — file gets decrypted content back
			const success = await sim.noteManager.unlockNote(file, sim.cachedKey!);
			expect(success).toBe(true);
			expect((sim.noteManager as any).app.vault._get("test.md")).toBe("My secret note");
		});
	});
});
