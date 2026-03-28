import { describe, it, expect, beforeEach, vi } from "vitest";
import { App, TFile, Platform } from "obsidian";
import { NoteManager } from "../src/note-manager";
import { AuthService } from "../src/auth";
import { SecretsPluginSettings, DEFAULT_SETTINGS } from "../src/types";
import { encrypt, generateSalt } from "../src/crypto";

/**
 * These tests simulate the plugin's state machine by directly exercising
 * the same logic paths as main.ts, without needing the full Plugin class.
 *
 * Key flows tested:
 * - Auth caching and cache invalidation
 * - Protect → lock → unlock sequence
 * - Lock clears auth cache (the bug that prompted these tests)
 */

const PASSWORD = "test-key";
const ITERATIONS = 1000;

// Simulates the plugin's auth/cache logic from main.ts
class PluginSimulator {
	settings: SecretsPluginSettings;
	noteManager: NoteManager;
	authService: AuthService;
	cachedKey: string | null = null;
	cachedKeyAt = 0;
	readonly AUTH_CACHE_MS = 30000;

	// Track whether auth was actually prompted
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

	// Mirrors main.ts authenticateForAction
	async authenticateForAction(_reason: string): Promise<string | null> {
		if (this.cachedKey && Date.now() - this.cachedKeyAt < this.AUTH_CACHE_MS) {
			return this.cachedKey;
		}
		this.authPrompted = true;
		// Simulate successful auth returning the key
		const key = this.authService.getEncryptionKey();
		if (key) {
			this.cachedKey = key;
			this.cachedKeyAt = Date.now();
		}
		return key;
	}

	// Mirrors main.ts cacheKey
	cacheKey(): void {
		const key = this.authService.getEncryptionKey();
		if (key) {
			this.cachedKey = key;
			this.cachedKeyAt = Date.now();
		}
	}

	// Mirrors main.ts doProtect (simplified)
	async doProtect(file: TFile): Promise<boolean> {
		if (!this.authService.hasPin()) {
			// First time: setup PIN
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

		// Set file content in vault
		(this.noteManager as any).app.vault._set(file.path, "test content");
		await this.noteManager.protectNote(file, key);
		return true;
	}

	// Mirrors main.ts lockNoteByFile (WITH the fix)
	lockNoteByFile(file: TFile): void {
		this.noteManager.lockNote(file.path);
		this.cachedKey = null;
		this.cachedKeyAt = 0;
	}

	// Mirrors main.ts lockAllNotes
	lockAllNotes(): void {
		this.noteManager.lockAll();
		this.cachedKey = null;
		this.cachedKeyAt = 0;
	}

	// Mirrors main.ts unlockNote
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
			// Protect (caches key)
			await sim.doProtect(file);
			expect(sim.cachedKey).not.toBeNull();
			expect(sim.noteManager.isUnlocked("test.md")).toBe(true);

			// Lock (should clear cache)
			sim.lockNoteByFile(file);
			expect(sim.cachedKey).toBeNull();
			expect(sim.cachedKeyAt).toBe(0);
			expect(sim.noteManager.isUnlocked("test.md")).toBe(false);

			// Unlock — must prompt for auth
			sim.authPrompted = false;
			await sim.unlockNote(file);
			expect(sim.authPrompted).toBe(true);
		});

		it("WITHOUT cache clear, unlock would skip auth (regression test)", async () => {
			await sim.doProtect(file);

			// Simulate the OLD bug: lock without clearing cache
			sim.noteManager.lockNote(file.path);
			// cachedKey NOT cleared (old behavior)

			sim.authPrompted = false;
			await sim.unlockNote(file);

			// This is the old buggy behavior — auth was NOT prompted
			// because cachedKey was still valid
			expect(sim.authPrompted).toBe(false);
		});
	});

	// ─── First-time protect: PIN setup, no re-auth ───

	describe("first-time protect flow", () => {
		it("sets up PIN and caches key without re-prompting", async () => {
			expect(sim.authService.hasPin()).toBe(false);

			sim.authPrompted = false;
			await sim.doProtect(file);

			// PIN was set
			expect(sim.authService.hasPin()).toBe(true);
			// Key cached without auth prompt (PIN setup is the proof of identity)
			expect(sim.cachedKey).not.toBeNull();
			// Note is protected and unlocked
			expect(sim.noteManager.isUnlocked("test.md")).toBe(true);
		});
	});

	// ─── Protect with existing PIN requires auth ───

	describe("protect with existing PIN", () => {
		it("requires authentication", async () => {
			// Set up PIN first
			await sim.doProtect(file);
			sim.lockNoteByFile(file);

			// Now protect a second note — should prompt auth
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
			// Key is cached now

			sim.authPrompted = false;
			await sim.authenticateForAction("some action");

			expect(sim.authPrompted).toBe(false); // Used cache
		});

		it("re-prompts after cache expires", async () => {
			await sim.doProtect(file);

			// Expire the cache
			sim.cachedKeyAt = Date.now() - 31000; // 31 seconds ago

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

			sim.lockAllNotes();

			expect(sim.cachedKey).toBeNull();
			expect(sim.cachedKeyAt).toBe(0);
		});

		it("locks all notes", async () => {
			const file2 = new TFile("second.md");
			(sim.noteManager as any).app.vault._set("second.md", "content");
			await sim.doProtect(file);
			await sim.doProtect(file2);

			sim.lockAllNotes();

			expect(sim.noteManager.isUnlocked("test.md")).toBe(false);
			expect(sim.noteManager.isUnlocked("second.md")).toBe(false);
		});
	});

	// ─── Encrypt → decrypt roundtrip through NoteManager ───

	describe("end-to-end encrypt/decrypt", () => {
		it("content survives protect → lock → unlock cycle", async () => {
			(sim.noteManager as any).app.vault._set("test.md", "My secret note content");

			// Protect
			await sim.authService.ensureEncryptionKey();
			if (!sim.settings.encryptionSalt) {
				sim.settings.encryptionSalt = generateSalt();
			}
			sim.cacheKey();
			await sim.noteManager.protectNote(file, sim.cachedKey!);

			// Lock
			sim.noteManager.lockNote("test.md");
			expect(sim.noteManager.getDecryptedContent("test.md")).toBeNull();

			// Unlock
			const success = await sim.noteManager.unlockNote(file, sim.cachedKey!);
			expect(success).toBe(true);
			expect(sim.noteManager.getDecryptedContent("test.md")).toBe("My secret note content");
		});
	});
});
