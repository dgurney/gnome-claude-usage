import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ClaudeUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup();
        const row = new Adw.SwitchRow({
            title: 'Show the Claude status',
            subtitle: 'Show the status from status.claude.com in the menu',
        });
        settings.bind('show-service-status', row, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(row);
        page.add(group);
        window.add(page);
    }
}
