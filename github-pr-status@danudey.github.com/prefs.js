import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Secret from 'gi://Secret';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SECRET_SCHEMA = new Secret.Schema(
    'org.gnome.shell.extensions.github-pr-status',
    Secret.SchemaFlags.NONE,
    {application: Secret.SchemaAttributeType.STRING},
);

const NOTIFICATION_REASONS = [
    {key: 'review_requested', label: 'Review Requested'},
    {key: 'mention', label: 'Mentioned'},
    {key: 'comment', label: 'Comment'},
    {key: 'assign', label: 'Assigned'},
    {key: 'state_change', label: 'State Change'},
];

// Promisify libsecret once at module load
Gio._promisify(Secret, 'password_lookup', 'password_lookup_finish');
Gio._promisify(Secret, 'password_store', 'password_store_finish');

export default class GitHubPRStatusPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // -- Authentication page --
        const authPage = new Adw.PreferencesPage({
            title: 'Authentication',
            icon_name: 'dialog-password-symbolic',
        });
        window.add(authPage);

        const tokenGroup = new Adw.PreferencesGroup({
            title: 'GitHub Token',
            description: 'A personal access token with "repo" and "notifications" scopes. Stored securely in GNOME Keyring.',
        });
        authPage.add(tokenGroup);

        const tokenRow = new Adw.PasswordEntryRow({
            title: 'Personal Access Token',
        });
        tokenGroup.add(tokenRow);

        const saveButton = new Gtk.Button({
            label: 'Save Token',
            css_classes: ['suggested-action'],
            valign: Gtk.Align.CENTER,
        });
        tokenRow.add_suffix(saveButton);

        // Load existing token
        this._loadToken(tokenRow);

        saveButton.connect('clicked', () => {
            const token = tokenRow.get_text();
            if (token) {
                this._saveToken(token, saveButton);
            }
        });

        // -- General page --
        const generalPage = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(generalPage);

        // Refresh interval
        const refreshGroup = new Adw.PreferencesGroup({
            title: 'Polling',
        });
        generalPage.add(refreshGroup);

        const intervalRow = new Adw.SpinRow({
            title: 'Refresh Interval',
            subtitle: 'How often to check GitHub (in minutes)',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 60,
                step_increment: 1,
                value: settings.get_int('refresh-interval') / 60,
            }),
        });
        refreshGroup.add(intervalRow);

        // Bind: spin row is in minutes, setting is in seconds
        intervalRow.connect('notify::value', () => {
            settings.set_int('refresh-interval', intervalRow.get_value() * 60);
        });
        settings.connect('changed::refresh-interval', () => {
            intervalRow.set_value(settings.get_int('refresh-interval') / 60);
        });

        // Notification filters
        const filterGroup = new Adw.PreferencesGroup({
            title: 'Notification Badge',
            description: 'Which notification types count toward the unread badge.',
        });
        generalPage.add(filterGroup);

        const activeFilters = settings.get_strv('notification-filters');

        for (const {key, label} of NOTIFICATION_REASONS) {
            const row = new Adw.SwitchRow({
                title: label,
                active: activeFilters.includes(key),
            });
            filterGroup.add(row);

            row.connect('notify::active', () => {
                const current = new Set(settings.get_strv('notification-filters'));
                if (row.get_active())
                    current.add(key);
                else
                    current.delete(key);
                settings.set_strv('notification-filters', [...current]);
            });
        }
    }

    async _loadToken(tokenRow) {
        try {
            const token = await Secret.password_lookup(
                SECRET_SCHEMA,
                {application: 'github-pr-status'},
                null,
            );
            if (token)
                tokenRow.set_text(token);
        } catch (e) {
            console.error(`[GitHub PR Status] Failed to load token: ${e.message}`);
        }
    }

    async _saveToken(token, button) {
        try {
            await Secret.password_store(
                SECRET_SCHEMA,
                {application: 'github-pr-status'},
                Secret.COLLECTION_DEFAULT,
                'GitHub PR Status Token',
                token,
                null,
            );
            button.set_label('Saved!');
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                button.set_label('Save Token');
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {
            console.error(`[GitHub PR Status] Failed to save token: ${e.message}`);
            button.set_label('Error!');
        }
    }
}
