const { Plugin, PluginSettingTab, Setting } = require("obsidian");

class FixtureSettingsTab extends PluginSettingTab {
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("knapper-settings-fixture");
    new Setting(containerEl)
      .setName("Enable fixture")
      .setDesc("Live UI state used by the Knapper acceptance suite.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enabled).onChange(async (enabled) => {
          this.plugin.settings.enabled = enabled;
          await this.plugin.saveData(this.plugin.settings);
        }),
      );
  }
}

module.exports = class KnapperSettingsFixture extends Plugin {
  async onload() {
    this.settings = Object.assign({ enabled: false }, await this.loadData());
    this.addSettingTab(new FixtureSettingsTab(this.app, this));
    this.addCommand({
      id: "throw-on-purpose",
      name: "Throw on purpose",
      callback: () => {
        throw new Error("knapper-settings-fixture deliberate error");
      },
    });
  }
};
