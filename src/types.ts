export interface SecretsPluginSettings {
	encryptionSalt: string;
	autoLockTimeoutMinutes: number;
	pbkdf2Iterations: number;
	lockOnBlur: boolean;
	/** Encryption key stored in plugin data (used on mobile where Keychain CLI is unavailable) */
	mobileEncryptionKey: string;
	/** PBKDF2 hash of the user's PIN/passcode */
	pinHash: string;
	/** Salt for PIN hashing */
	pinSalt: string;
	/** Type of PIN: "numeric" for number pad, "alphanumeric" for keyboard, "" for not set */
	pinType: "numeric" | "alphanumeric" | "";
}

export const DEFAULT_SETTINGS: SecretsPluginSettings = {
	encryptionSalt: "",
	autoLockTimeoutMinutes: 5,
	pbkdf2Iterations: 600000,
	lockOnBlur: false,
	mobileEncryptionKey: "",
	pinHash: "",
	pinSalt: "",
	pinType: "",
};

export interface EncryptedPayload {
	v: number;
	iv: string;
	ct: string;
}

export interface ProtectedNoteState {
	path: string;
	unlocked: boolean;
	decryptedContent: string | null;
	unlockedAt: number | null;
}

export const ENCRYPTED_MARKER_START = "%%secrets-encrypted%%";
export const ENCRYPTED_MARKER_END = "%%secrets-end%%";
export const FRONTMATTER_KEY = "secrets-protected";
export const FRONTMATTER_VERSION_KEY = "secrets-version";
export const FORMAT_VERSION = 1;
