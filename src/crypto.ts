import { EncryptedPayload } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

function fromBase64(base64: string): ArrayBuffer {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer as ArrayBuffer;
}

export function generateSalt(): string {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	return toBase64(salt.buffer as ArrayBuffer);
}

async function importPasswordKey(password: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		encoder.encode(password),
		"PBKDF2",
		false,
		["deriveKey", "deriveBits"]
	);
}

export async function deriveEncryptionKey(
	password: string,
	salt: string,
	iterations: number
): Promise<CryptoKey> {
	const baseKey = await importPasswordKey(password);
	return crypto.subtle.deriveKey(
		{
			name: "PBKDF2",
			salt: fromBase64(salt),
			iterations,
			hash: "SHA-256",
		},
		baseKey,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"]
	);
}

export async function hashPassword(
	password: string,
	salt: string,
	iterations: number
): Promise<string> {
	const baseKey = await importPasswordKey(password);
	const hashBits = await crypto.subtle.deriveBits(
		{
			name: "PBKDF2",
			salt: fromBase64(salt),
			iterations,
			hash: "SHA-256",
		},
		baseKey,
		256
	);
	return toBase64(hashBits);
}

export async function encrypt(
	plaintext: string,
	password: string,
	encryptionSalt: string,
	iterations: number
): Promise<EncryptedPayload> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ivBuffer = iv.buffer as ArrayBuffer;
	const key = await deriveEncryptionKey(password, encryptionSalt, iterations);
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: ivBuffer },
		key,
		encoder.encode(plaintext)
	);
	return {
		v: 1,
		iv: toBase64(ivBuffer),
		ct: toBase64(ciphertext),
	};
}

export async function decrypt(
	payload: EncryptedPayload,
	password: string,
	encryptionSalt: string,
	iterations: number
): Promise<string> {
	const key = await deriveEncryptionKey(password, encryptionSalt, iterations);
	const plaintext = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: fromBase64(payload.iv) },
		key,
		fromBase64(payload.ct)
	);
	return decoder.decode(plaintext);
}
