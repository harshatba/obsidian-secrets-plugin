import { App, Notice, Platform } from "obsidian";
import { generateSalt, hashPassword } from "./crypto";
import { SecretsPluginSettings } from "./types";
import { PinSetupModal, PinEntryModal } from "./ui/pin-modal";

const KEYCHAIN_ACCOUNT = "obsidian-secrets";
const KEYCHAIN_SERVICE = "obsidian-secrets-plugin";

export class AuthService {
	private app: App;
	private biometricAvailable: boolean | null = null;
	private settings: () => SecretsPluginSettings;
	private saveSettings: () => Promise<void>;
	private pinFailCount = 0;

	constructor(
		app: App,
		getSettings: () => SecretsPluginSettings,
		saveSettings: () => Promise<void>
	) {
		this.app = app;
		this.settings = getSettings;
		this.saveSettings = saveSettings;
	}

	// ─── PIN Management ───

	hasPin(): boolean {
		return this.settings().pinHash !== "";
	}

	/**
	 * Show PIN setup modal. Returns true if PIN was set successfully.
	 */
	async setupPin(): Promise<boolean> {
		return new Promise((resolve) => {
			new PinSetupModal(
				this.app,
				async (pin, type) => {
					const salt = generateSalt();
					const hash = await hashPassword(
						pin,
						salt,
						this.settings().pbkdf2Iterations
					);
					const settings = this.settings();
					settings.pinHash = hash;
					settings.pinSalt = salt;
					settings.pinType = type;
					await this.saveSettings();
					new Notice("Passcode set successfully");
					resolve(true);
				},
				() => resolve(false)
			).open();
		});
	}

	private async verifyPin(pin: string): Promise<boolean> {
		const settings = this.settings();
		const hash = await hashPassword(
			pin,
			settings.pinSalt,
			settings.pbkdf2Iterations
		);
		return hash === settings.pinHash;
	}

	private async promptPin(): Promise<boolean> {
		if (this.pinFailCount >= 5) {
			const delay = Math.min(
				1000 * Math.pow(2, this.pinFailCount - 3),
				30000
			);
			new Notice(
				`Too many failed attempts. Please wait ${Math.ceil(delay / 1000)} seconds.`
			);
			await new Promise((r) => setTimeout(r, delay));
		}

		const settings = this.settings();
		const pinType = settings.pinType as "numeric" | "alphanumeric";

		return new Promise((resolve) => {
			new PinEntryModal(
				this.app,
				pinType,
				this.pinFailCount,
				async (pin) => {
					const valid = await this.verifyPin(pin);
					if (valid) {
						this.pinFailCount = 0;
						resolve(true);
					} else {
						this.pinFailCount++;
						new Notice("Incorrect passcode");
						resolve(false);
					}
				},
				() => resolve(false)
			).open();
		});
	}

	// ─── Device Auth (macOS Touch ID) ───

	isDeviceAuthSupported(): boolean {
		if (!Platform.isMacOS) return false;
		if (this.biometricAvailable !== null) return this.biometricAvailable;
		try {
			const { execSync } = require("child_process");
			const result = execSync(
				`swift -e 'import LocalAuthentication; let c = LAContext(); var e: NSError?; print(c.canEvaluatePolicy(.deviceOwnerAuthentication, error: &e) ? "Y" : "N")'`,
				{ timeout: 5000, encoding: "utf-8" }
			).trim();
			this.biometricAvailable = result === "Y";
			return this.biometricAvailable;
		} catch {
			this.biometricAvailable = false;
			return false;
		}
	}

	isBiometricSupported(): boolean {
		return this.isDeviceAuthSupported();
	}

	private async promptDeviceAuth(reason: string): Promise<boolean> {
		try {
			const { execFile } = require("child_process");
			const safeReason = reason.replace(/'/g, "\\'");
			const script = `
import LocalAuthentication
import Foundation
let ctx = LAContext()
var error: NSError?
guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
    print("UNAVAILABLE")
    exit(1)
}
let sem = DispatchSemaphore(value: 0)
ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "${safeReason}") { success, err in
    print(success ? "OK" : "FAIL")
    sem.signal()
}
sem.wait()
`;
			return await new Promise<boolean>((resolve) => {
				execFile(
					"swift",
					["-e", script],
					{ timeout: 30000 },
					(error: Error | null, stdout: string) => {
						resolve(stdout?.trim() === "OK");
					}
				);
			});
		} catch {
			return false;
		}
	}

	// ─── Encryption Key Management ───

	async ensureEncryptionKey(): Promise<boolean> {
		const settings = this.settings();

		if (settings.mobileEncryptionKey) {
			if (Platform.isMacOS && !this.getKeychainKey()) {
				this.storeKeychainKey(settings.mobileEncryptionKey);
			}
			return true;
		}

		if (Platform.isMacOS) {
			const keychainKey = this.getKeychainKey();
			if (keychainKey) {
				settings.mobileEncryptionKey = keychainKey;
				await this.saveSettings();
				return true;
			}
		}

		const key = generateSalt() + generateSalt();
		settings.mobileEncryptionKey = key;
		await this.saveSettings();

		if (Platform.isMacOS) {
			this.storeKeychainKey(key);
		}

		return true;
	}

	getEncryptionKey(): string | null {
		// mobileEncryptionKey is the source of truth (syncs across devices)
		// Keychain is just a local cache on macOS
		return this.settings().mobileEncryptionKey || null;
	}

	// ─── Main Authenticate ───

	/**
	 * Authenticate the user and return the encryption key.
	 *
	 * macOS + Touch ID: Touch ID first. If cancelled, fall back to PIN only if PIN exists.
	 *   Touch ID alone is sufficient — no PIN required on Mac.
	 * Mobile / no Touch ID: PIN required.
	 */
	async authenticate(reason: string): Promise<string | null> {
		// macOS with Touch ID: Touch ID is primary, PIN is optional fallback
		if (this.isDeviceAuthSupported()) {
			const success = await this.promptDeviceAuth(reason);
			if (success) {
				await this.ensureEncryptionKey();
				return this.getEncryptionKey();
			}
			// Touch ID failed/cancelled — try PIN if available
			if (this.hasPin()) {
				const pinOk = await this.promptPin();
				if (pinOk) {
					await this.ensureEncryptionKey();
					return this.getEncryptionKey();
				}
			}
			return null;
		}

		// Mobile / no Touch ID: PIN is required
		if (!this.hasPin()) {
			new Notice("No passcode set. Please protect a note first to set one up.");
			return null;
		}
		const pinOk = await this.promptPin();
		if (pinOk) {
			await this.ensureEncryptionKey();
			return this.getEncryptionKey();
		}
		return null;
	}

	// ─── Keychain helpers (macOS only) ───

	private getKeychainKey(): string | null {
		try {
			const { execSync } = require("child_process");
			const result = execSync(
				`security find-generic-password -a "${KEYCHAIN_ACCOUNT}" -s "${KEYCHAIN_SERVICE}" -w`,
				{ encoding: "utf-8", timeout: 5000 }
			);
			return result.trim() || null;
		} catch {
			return null;
		}
	}

	private storeKeychainKey(key: string): boolean {
		try {
			const { execSync } = require("child_process");
			try {
				execSync(
					`security delete-generic-password -a "${KEYCHAIN_ACCOUNT}" -s "${KEYCHAIN_SERVICE}" 2>/dev/null`,
					{ encoding: "utf-8" }
				);
			} catch {
				// ignore
			}
			execSync(
				`security add-generic-password -a "${KEYCHAIN_ACCOUNT}" -s "${KEYCHAIN_SERVICE}" -w "${key}" -U`,
				{ encoding: "utf-8", timeout: 5000 }
			);
			return true;
		} catch {
			return false;
		}
	}

	async clearEncryptionKey(): Promise<void> {
		if (Platform.isMacOS) {
			try {
				const { execSync } = require("child_process");
				execSync(
					`security delete-generic-password -a "${KEYCHAIN_ACCOUNT}" -s "${KEYCHAIN_SERVICE}" 2>/dev/null`,
					{ encoding: "utf-8" }
				);
			} catch {
				// ignore
			}
		}
		const settings = this.settings();
		settings.mobileEncryptionKey = "";
		await this.saveSettings();
	}
}
