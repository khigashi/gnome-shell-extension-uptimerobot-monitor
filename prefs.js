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
            subtitle: 'You need an API Key from UptimeRobot API v2. Find it in Integrations & API > API',
            activatable: true,
        });
        
        const helpIcon = new Gtk.Image({
            icon_name: 'web-browser-symbolic',
            pixel_size: 16
        });
        helpRow.add_suffix(helpIcon);
        
        helpRow.connect('activated', () => {
            try {
                Gtk.show_uri(window, 'https://dashboard.uptimerobot.com/integrations', Gtk.get_current_event_time());
            } catch (e) {
                try {
                    GLib.spawn_command_line_async('xdg-open https://dashboard.uptimerobot.com/integrations');
                } catch (e2) {
                    console.error('Failed to open URL:', e2);
                }
            }
        });
        
        group.add(helpRow);
        page.add(group);
        window.add(page);
    }
}

