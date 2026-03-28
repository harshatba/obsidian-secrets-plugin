import { describe, it, expect, beforeEach } from "vitest";
import { App, Platform } from "obsidian";
import { AuthService } from "../src/auth";
import { SecretsPluginSettings, DEFAULT_SETTINGS } from "../src/types";
import { generateSalt, hashPassword } from "../src/crypto";

const ITERATIONS = 1000;

function makeSettings(overrides?: Partial<SecretsPluginSettings>): SecretsPluginSettings {
	return { ...DEFAULT_SETTINGS, pbkdf2Iterations: ITERATIONS, ...overrides };
}

describe("AuthService", () => {
	let settings: SecretsPluginSettings;
	let auth: AuthService;
	let saved: boolean;

	beforeEach(() => {
		settings = makeSettings();
		saved = false;
		// Force non-Mac so biometric checks are skipped
		(Platform as any).isMacOS = false;
		auth = new AuthService(
			new App(),
			() => settings,
			async () => { saved = true; }
		);
	});

	// ─── hasPin ───

	describe("hasPin", () => {
		it("returns false when no PIN is set", () => {
			expect(auth.hasPin()).toBe(false);
		});

		it("returns true when PIN hash exists", () => {
			settings.pinHash = "somehash";
			expect(auth.hasPin()).toBe(true);
		});
	});

	// ─── ensureEncryptionKey ───

	describe("ensureEncryptionKey", () => {
		it("generates a key if none exists", async () => {
			expect(settings.mobileEncryptionKey).toBe("");

			const result = await auth.ensureEncryptionKey();

			expect(result).toBe(true);
			expect(settings.mobileEncryptionKey).not.toBe("");
			expect(settings.mobileEncryptionKey.length).toBeGreaterThan(0);
			expect(saved).toBe(true);
		});

		it("preserves existing key", async () => {
			settings.mobileEncryptionKey = "existing-key-abc";

			const result = await auth.ensureEncryptionKey();

			expect(result).toBe(true);
			expect(settings.mobileEncryptionKey).toBe("existing-key-abc");
		});
	});

	// ─── getEncryptionKey ───

	describe("getEncryptionKey", () => {
		it("returns null when no key exists", () => {
			expect(auth.getEncryptionKey()).toBeNull();
		});

		it("returns the mobileEncryptionKey", () => {
			settings.mobileEncryptionKey = "my-key";
			expect(auth.getEncryptionKey()).toBe("my-key");
		});
	});

	// ─── PIN verification (internal) ───

	describe("PIN verification", () => {
		it("can verify a correctly hashed PIN", async () => {
			// Manually set up a PIN
			const pin = "1234";
			const salt = generateSalt();
			const hash = await hashPassword(pin, salt, ITERATIONS);
			settings.pinHash = hash;
			settings.pinSalt = salt;
			settings.pinType = "numeric";

			// Verify by re-hashing
			const rehash = await hashPassword(pin, salt, ITERATIONS);
			expect(rehash).toBe(hash);
		});

		it("wrong PIN produces different hash", async () => {
			const salt = generateSalt();
			const correctHash = await hashPassword("1234", salt, ITERATIONS);
			const wrongHash = await hashPassword("5678", salt, ITERATIONS);
			expect(wrongHash).not.toBe(correctHash);
		});
	});

	// ─── authenticate (non-Mac, no PIN) ───

	describe("authenticate without PIN", () => {
		it("returns null when no PIN is set on mobile", async () => {
			(Platform as any).isMacOS = false;
			const key = await auth.authenticate("test");
			expect(key).toBeNull();
		});
	});

	// ─── isDeviceAuthSupported ───

	describe("isDeviceAuthSupported", () => {
		it("returns false on non-Mac platforms", () => {
			(Platform as any).isMacOS = false;
			expect(auth.isDeviceAuthSupported()).toBe(false);
		});
	});

	// ─── clearEncryptionKey ───

	describe("clearEncryptionKey", () => {
		it("clears the mobileEncryptionKey", async () => {
			settings.mobileEncryptionKey = "some-key";

			await auth.clearEncryptionKey();

			expect(settings.mobileEncryptionKey).toBe("");
			expect(saved).toBe(true);
		});
	});
});
