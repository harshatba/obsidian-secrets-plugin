import { describe, it, expect, beforeEach } from "vitest";
import { App, TFile, Vault } from "obsidian";
import { NoteManager } from "../src/note-manager";
import { SecretsPluginSettings, DEFAULT_SETTINGS, ENCRYPTED_MARKER_START, ENCRYPTED_MARKER_END, FRONTMATTER_KEY } from "../src/types";
import { encrypt, generateSalt } from "../src/crypto";

const PASSWORD = "test-key";
const SALT = generateSalt();
const ITERATIONS = 1000;

function makeSettings(overrides?: Partial<SecretsPluginSettings>): SecretsPluginSettings {
	return { ...DEFAULT_SETTINGS, encryptionSalt: SALT, pbkdf2Iterations: ITERATIONS, encryptedNotes: {}, ...overrides };
}

function makeApp(files?: Record<string, string>): App {
	const app = new App();
	if (files) {
		for (const [path, content] of Object.entries(files)) {
			(app.vault as any)._set(path, content);
		}
	}
	return app;
}

describe("NoteManager", () => {
	let settings: SecretsPluginSettings;
	let app: App;
	let manager: NoteManager;
	let saved: boolean;

	beforeEach(() => {
		settings = makeSettings();
		app = makeApp({ "note.md": "Hello world" });
		saved = false;
		manager = new NoteManager(
			app,
			() => settings,
			async () => { saved = true; }
		);
	});

	const file = new TFile("note.md");

	// ─── protectNote ───

	describe("protectNote", () => {
		it("encrypts content, stores payload in settings, keeps file content", async () => {
			await manager.protectNote(file, PASSWORD);

			// Payload stored in settings
			expect(settings.encryptedNotes["note.md"]).toBeDefined();
			expect(settings.encryptedNotes["note.md"].v).toBe(1);

			// File keeps original content (note stays unlocked after protect)
			const fileContent = await app.vault.read(file);
			expect(fileContent).toBe("Hello world");

			expect(saved).toBe(true);
		});

		it("sets state as unlocked with decrypted content", async () => {
			await manager.protectNote(file, PASSWORD);

			expect(manager.isUnlocked("note.md")).toBe(true);
			expect(manager.getDecryptedContent("note.md")).toBe("Hello world");
		});

		it("rejects if already protected (encryptedNotes)", async () => {
			settings.encryptedNotes["note.md"] = { v: 1, iv: "x", ct: "y" };

			await manager.protectNote(file, PASSWORD);

			expect(settings.encryptedNotes["note.md"].iv).toBe("x");
		});

		it("rejects if already protected (frontmatter)", async () => {
			(app.metadataCache as any)._setCache("note.md", {
				frontmatter: { [FRONTMATTER_KEY]: true },
			});

			await manager.protectNote(file, PASSWORD);

			expect(settings.encryptedNotes["note.md"]).toBeUndefined();
		});

		it("rejects if already protected (legacy markers)", async () => {
			(app.vault as any)._set("note.md", `${ENCRYPTED_MARKER_START}data${ENCRYPTED_MARKER_END}`);

			await manager.protectNote(file, PASSWORD);

			expect(settings.encryptedNotes["note.md"]).toBeUndefined();
		});
	});

	// ─── unlockNote ───

	describe("unlockNote", () => {
		it("decrypts, writes content to file, sets state to unlocked", async () => {
			await manager.protectNote(file, PASSWORD);
			await manager.lockNote(file, PASSWORD);

			const result = await manager.unlockNote(file, PASSWORD);

			expect(result).toBe(true);
			expect(manager.isUnlocked("note.md")).toBe(true);
			expect(manager.getDecryptedContent("note.md")).toBe("Hello world");
			// File now has decrypted content
			const fileContent = await app.vault.read(file);
			expect(fileContent).toBe("Hello world");
		});

		it("returns false with wrong key", async () => {
			await manager.protectNote(file, PASSWORD);
			await manager.lockNote(file, PASSWORD);

			const result = await manager.unlockNote(file, "wrong-key");

			expect(result).toBe(false);
			expect(manager.isUnlocked("note.md")).toBe(false);
		});

		it("migrates legacy in-file format to encryptedNotes", async () => {
			const payload = await encrypt("Legacy content", PASSWORD, SALT, ITERATIONS);
			const legacyContent = [
				"---",
				`${FRONTMATTER_KEY}: true`,
				"---",
				"",
				ENCRYPTED_MARKER_START,
				btoa(JSON.stringify(payload)),
				ENCRYPTED_MARKER_END,
			].join("\n");
			(app.vault as any)._set("note.md", legacyContent);

			const result = await manager.unlockNote(file, PASSWORD);

			expect(result).toBe(true);
			expect(manager.getDecryptedContent("note.md")).toBe("Legacy content");
			expect(settings.encryptedNotes["note.md"]).toBeDefined();
			// File now has decrypted content (not legacy markers)
			const fileContent = await app.vault.read(file);
			expect(fileContent).toBe("Legacy content");
		});
	});

	// ─── lockNote ───

	describe("lockNote", () => {
		it("re-encrypts, writes placeholder, clears state", async () => {
			await manager.protectNote(file, PASSWORD);
			expect(manager.isUnlocked("note.md")).toBe(true);

			await manager.lockNote(file, PASSWORD);

			expect(manager.isUnlocked("note.md")).toBe(false);
			expect(manager.getDecryptedContent("note.md")).toBeNull();
			// File replaced with placeholder
			const fileContent = await app.vault.read(file);
			expect(fileContent).toContain(`${FRONTMATTER_KEY}: true`);
			expect(fileContent).not.toContain("Hello world");
			// Encrypted payload updated
			expect(settings.encryptedNotes["note.md"]).toBeDefined();
		});

		it("captures edits made while unlocked", async () => {
			await manager.protectNote(file, PASSWORD);
			// Simulate user editing the file
			(app.vault as any)._set("note.md", "Edited content");

			await manager.lockNote(file, PASSWORD);

			// Unlock to verify the edited content was captured
			await manager.unlockNote(file, PASSWORD);
			expect(manager.getDecryptedContent("note.md")).toBe("Edited content");
		});
	});

	// ─── lockAll ───

	describe("lockAll", () => {
		it("locks all unlocked notes", async () => {
			const file2 = new TFile("note2.md");
			(app.vault as any)._set("note2.md", "Second note");

			await manager.protectNote(file, PASSWORD);
			await manager.protectNote(file2, PASSWORD);

			expect(manager.isUnlocked("note.md")).toBe(true);
			expect(manager.isUnlocked("note2.md")).toBe(true);

			await manager.lockAll(PASSWORD);

			expect(manager.isUnlocked("note.md")).toBe(false);
			expect(manager.isUnlocked("note2.md")).toBe(false);
		});
	});

	// ─── unprotectNote ───

	describe("unprotectNote", () => {
		it("restores original content and removes from encryptedNotes", async () => {
			await manager.protectNote(file, PASSWORD);

			const result = await manager.unprotectNote(file, PASSWORD);

			expect(result).toBe(true);
			const fileContent = await app.vault.read(file);
			expect(fileContent).toBe("Hello world");
			expect(settings.encryptedNotes["note.md"]).toBeUndefined();
			expect(manager.getState("note.md")).toBeUndefined();
		});

		it("returns false with wrong key", async () => {
			await manager.protectNote(file, PASSWORD);

			const result = await manager.unprotectNote(file, "wrong-key");

			expect(result).toBe(false);
			expect(settings.encryptedNotes["note.md"]).toBeDefined();
		});
	});

	// ─── saveEncrypted ───

	describe("saveEncrypted", () => {
		it("updates the encryptedNotes entry", async () => {
			const payload = { v: 1, iv: "new-iv", ct: "new-ct" };
			await manager.saveEncrypted(file, payload);

			expect(settings.encryptedNotes["note.md"]).toEqual(payload);
			expect(saved).toBe(true);
		});
	});

	// ─── handleRename ───

	describe("handleRename", () => {
		it("updates encryptedNotes key and state", async () => {
			await manager.protectNote(file, PASSWORD);

			manager.handleRename("note.md", "renamed.md");

			expect(settings.encryptedNotes["note.md"]).toBeUndefined();
			expect(settings.encryptedNotes["renamed.md"]).toBeDefined();
			expect(manager.isUnlocked("renamed.md")).toBe(true);
			expect(manager.isUnlocked("note.md")).toBe(false);
		});
	});

	// ─── handleDelete ───

	describe("handleDelete", () => {
		it("removes from encryptedNotes and state", async () => {
			await manager.protectNote(file, PASSWORD);

			manager.handleDelete("note.md");

			expect(settings.encryptedNotes["note.md"]).toBeUndefined();
			expect(manager.getState("note.md")).toBeUndefined();
		});
	});

	// ─── checkAutoLock ───

	describe("checkAutoLock", () => {
		it("returns paths of notes past the timeout", async () => {
			await manager.protectNote(file, PASSWORD);
			const state = manager.getState("note.md")!;
			state.unlockedAt = Date.now() - 6 * 60 * 1000;

			const expired = manager.checkAutoLock(5);

			expect(expired).toContain("note.md");
		});

		it("does not return recent notes", async () => {
			await manager.protectNote(file, PASSWORD);

			const expired = manager.checkAutoLock(5);

			expect(expired).toHaveLength(0);
		});

		it("returns empty when timeout is 0 (never)", async () => {
			await manager.protectNote(file, PASSWORD);
			const state = manager.getState("note.md")!;
			state.unlockedAt = Date.now() - 999999999;

			const expired = manager.checkAutoLock(0);

			expect(expired).toHaveLength(0);
		});
	});

	// ─── isProtectedSync ───

	describe("isProtectedSync", () => {
		it("returns true if in encryptedNotes", () => {
			settings.encryptedNotes["note.md"] = { v: 1, iv: "x", ct: "y" };
			expect(manager.isProtectedSync(file)).toBe(true);
		});

		it("returns true if in states map", async () => {
			await manager.protectNote(file, PASSWORD);
			expect(manager.isProtectedSync(file)).toBe(true);
		});

		it("returns true if frontmatter says protected", () => {
			(app.metadataCache as any)._setCache("note.md", {
				frontmatter: { [FRONTMATTER_KEY]: true },
			});
			expect(manager.isProtectedSync(file)).toBe(true);
		});

		it("returns false for unprotected note", () => {
			expect(manager.isProtectedSync(file)).toBe(false);
		});
	});

	// ─── Full cycle: protect → lock → unlock → edit → lock ───

	describe("full lifecycle", () => {
		it("preserves content through protect → lock → unlock → edit → lock → unlock", async () => {
			// Protect
			await manager.protectNote(file, PASSWORD);
			expect(await app.vault.read(file)).toBe("Hello world");

			// Lock — placeholder written
			await manager.lockNote(file, PASSWORD);
			expect(await app.vault.read(file)).toContain(FRONTMATTER_KEY);
			expect(await app.vault.read(file)).not.toContain("Hello world");

			// Unlock — decrypted content written
			await manager.unlockNote(file, PASSWORD);
			expect(await app.vault.read(file)).toBe("Hello world");

			// User edits the file
			(app.vault as any)._set("note.md", "Edited by user");

			// Lock — captures edit
			await manager.lockNote(file, PASSWORD);

			// Unlock — should have the edit
			await manager.unlockNote(file, PASSWORD);
			expect(await app.vault.read(file)).toBe("Edited by user");
			expect(manager.getDecryptedContent("note.md")).toBe("Edited by user");
		});
	});
});
