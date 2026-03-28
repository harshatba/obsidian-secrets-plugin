import { describe, it, expect } from "vitest";
import {
	encrypt,
	decrypt,
	generateSalt,
	hashPassword,
} from "../src/crypto";

const TEST_PASSWORD = "test-key-123";
const TEST_SALT = generateSalt();
const ITERATIONS = 1000; // Low for fast tests

describe("crypto", () => {
	describe("encrypt/decrypt roundtrip", () => {
		it("decrypts back to original plaintext", async () => {
			const plaintext = "Hello, secret world!";
			const payload = await encrypt(plaintext, TEST_PASSWORD, TEST_SALT, ITERATIONS);
			const result = await decrypt(payload, TEST_PASSWORD, TEST_SALT, ITERATIONS);
			expect(result).toBe(plaintext);
		});

		it("handles empty string", async () => {
			const payload = await encrypt("", TEST_PASSWORD, TEST_SALT, ITERATIONS);
			const result = await decrypt(payload, TEST_PASSWORD, TEST_SALT, ITERATIONS);
			expect(result).toBe("");
		});

		it("handles unicode content", async () => {
			const plaintext = "日本語テスト 🔒 émojis";
			const payload = await encrypt(plaintext, TEST_PASSWORD, TEST_SALT, ITERATIONS);
			const result = await decrypt(payload, TEST_PASSWORD, TEST_SALT, ITERATIONS);
			expect(result).toBe(plaintext);
		});

		it("handles large content", async () => {
			const plaintext = "x".repeat(100000);
			const payload = await encrypt(plaintext, TEST_PASSWORD, TEST_SALT, ITERATIONS);
			const result = await decrypt(payload, TEST_PASSWORD, TEST_SALT, ITERATIONS);
			expect(result).toBe(plaintext);
		});
	});

	describe("decrypt with wrong key", () => {
		it("throws on wrong password", async () => {
			const payload = await encrypt("secret", TEST_PASSWORD, TEST_SALT, ITERATIONS);
			await expect(
				decrypt(payload, "wrong-password", TEST_SALT, ITERATIONS)
			).rejects.toThrow();
		});

		it("throws on wrong salt", async () => {
			const payload = await encrypt("secret", TEST_PASSWORD, TEST_SALT, ITERATIONS);
			const wrongSalt = generateSalt();
			await expect(
				decrypt(payload, TEST_PASSWORD, wrongSalt, ITERATIONS)
			).rejects.toThrow();
		});
	});

	describe("IV uniqueness", () => {
		it("generates different IVs for each encrypt call", async () => {
			const p1 = await encrypt("same text", TEST_PASSWORD, TEST_SALT, ITERATIONS);
			const p2 = await encrypt("same text", TEST_PASSWORD, TEST_SALT, ITERATIONS);
			expect(p1.iv).not.toBe(p2.iv);
		});

		it("produces different ciphertexts for same plaintext", async () => {
			const p1 = await encrypt("same text", TEST_PASSWORD, TEST_SALT, ITERATIONS);
			const p2 = await encrypt("same text", TEST_PASSWORD, TEST_SALT, ITERATIONS);
			expect(p1.ct).not.toBe(p2.ct);
		});
	});

	describe("generateSalt", () => {
		it("produces unique values", () => {
			const salts = new Set(Array.from({ length: 20 }, () => generateSalt()));
			expect(salts.size).toBe(20);
		});

		it("returns a non-empty base64 string", () => {
			const salt = generateSalt();
			expect(salt.length).toBeGreaterThan(0);
			// Base64 chars only
			expect(salt).toMatch(/^[A-Za-z0-9+/=]+$/);
		});
	});

	describe("hashPassword", () => {
		it("is deterministic (same input → same output)", async () => {
			const salt = generateSalt();
			const h1 = await hashPassword("mypin", salt, ITERATIONS);
			const h2 = await hashPassword("mypin", salt, ITERATIONS);
			expect(h1).toBe(h2);
		});

		it("produces different hashes for different passwords", async () => {
			const salt = generateSalt();
			const h1 = await hashPassword("1234", salt, ITERATIONS);
			const h2 = await hashPassword("5678", salt, ITERATIONS);
			expect(h1).not.toBe(h2);
		});

		it("produces different hashes for different salts", async () => {
			const h1 = await hashPassword("1234", generateSalt(), ITERATIONS);
			const h2 = await hashPassword("1234", generateSalt(), ITERATIONS);
			expect(h1).not.toBe(h2);
		});
	});

	describe("payload format", () => {
		it("has version, iv, and ct fields", async () => {
			const payload = await encrypt("test", TEST_PASSWORD, TEST_SALT, ITERATIONS);
			expect(payload).toHaveProperty("v", 1);
			expect(payload).toHaveProperty("iv");
			expect(payload).toHaveProperty("ct");
			expect(typeof payload.iv).toBe("string");
			expect(typeof payload.ct).toBe("string");
		});
	});
});
