import { App, PluginSettingTab, Setting } from "obsidian";
import type SecretsPlugin from "./main";

export class SecretsSettingTab extends PluginSettingTab {
	plugin: SecretsPlugin;

	constructor(app: App, plugin: SecretsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Secrets" });

		containerEl.createEl("p", {
			text: "Notes are protected using your device authentication (Touch ID on Mac, passcode on mobile). Encrypted data is stored in plugin data.",
			cls: "setting-item-description",
		});

		// Auto-lock timeout
		new Setting(containerEl)
			.setName("Auto-lock timeout")
			.setDesc(
				"Automatically lock unlocked notes after this period of inactivity."
			)
			.addDropdown((dropdown) => {
				dropdown
					.addOption("1", "1 minute")
					.addOption("5", "5 minutes")
					.addOption("15", "15 minutes")
					.addOption("30", "30 minutes")
					.addOption("60", "1 hour")
					.addOption("0", "Never")
					.setValue(
						String(this.plugin.settings.autoLockTimeoutMinutes)
					)
					.onChange(async (value) => {
						this.plugin.settings.autoLockTimeoutMinutes =
							parseInt(value);
						await this.plugin.saveSettings();
					});
			});

		// Lock on blur
		new Setting(containerEl)
			.setName("Lock when Obsidian loses focus")
			.setDesc(
				"Lock all protected notes when you switch to another app."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.lockOnBlur)
					.onChange(async (value) => {
						this.plugin.settings.lockOnBlur = value;
						await this.plugin.saveSettings();
					});
			});
	}
}
