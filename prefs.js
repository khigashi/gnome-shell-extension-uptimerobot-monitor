import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';

export default class UptimeRobotPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        
        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'dialog-information-symbolic',
        });
        
        const group = new Adw.PreferencesGroup({
            title: 'UptimeRobot Settings',
            description: 'Configure your UptimeRobot API key to monitor your websites (API v2)',
        });
        
        const apiKeyRow = new Adw.EntryRow({
            title: 'API Key',
            text: settings.get_string('api-key'),
        });
        
        apiKeyRow.connect('changed', () => {
            settings.set_string('api-key', apiKeyRow.get_text());
        });
        
        group.add(apiKeyRow);
        
        const helpRow = new Adw.ActionRow({
            title: 'Get your API Key',
            subtitle: 'Login to your UptimeRobot dashboard, then go to My Settings > API Settings to generate or find your API key.'
        });
        
        group.add(helpRow);
        page.add(group);
        window.add(page);
    }
}

