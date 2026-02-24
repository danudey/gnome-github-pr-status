import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Secret from 'gi://Secret';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import GitHubClient from './github.js';

const SECRET_SCHEMA = new Secret.Schema(
    'org.gnome.shell.extensions.github-pr-status',
    Secret.SchemaFlags.NONE,
    {application: Secret.SchemaAttributeType.STRING},
);

const CI_ICONS = {
    success: '\u2705',  // ✅
    failure: '\u274C',  // ❌
    pending: '\u23F3',  // ⏳
    none: '\u2B1C',     // ⬜
};

const REVIEW_ICONS = {
    APPROVED: '\u2705',
    CHANGES_REQUESTED: '\u274C',
    COMMENTED: '\u{1F4AC}',
    PENDING: '\u23F3',
    DISMISSED: '\u2796',
};

const CATEGORY_META = [
    {key: 'approved', label: 'Approved', icon: CI_ICONS.success},
    {key: 'changesRequested', label: 'Changes Requested', icon: CI_ICONS.failure},
    {key: 'reviewRequired', label: 'Review Required', icon: CI_ICONS.pending},
    {key: 'draft', label: 'Draft', icon: '\u{1F4DD}'},
];

// Promisify libsecret once at module load
Gio._promisify(Secret, 'password_lookup', 'password_lookup_finish');

const GitHubPRButton = GObject.registerClass(
class GitHubPRButton extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'GitHub PR Status');

        this._extension = extension;
        this._settings = extension.getSettings();
        this._client = new GitHubClient();
        this._timerId = null;
        this._settingsConnections = [];
        this._lastCategories = null;
        this._lastNotificationCount = 0;

        // Panel icon
        const iconPath = extension.path + '/icons/github-symbolic.svg';
        const gicon = Gio.icon_new_for_string(iconPath);
        this._icon = new St.Icon({
            gicon,
            style_class: 'system-status-icon',
        });

        // Badge label
        this._badge = new St.Label({
            text: '',
            style_class: 'github-pr-badge',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._badge.hide();

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        box.add_child(this._icon);
        box.add_child(this._badge);
        this.add_child(box);

        // Initial menu
        this._buildMenuLoading();

        // Watch settings changes
        this._settingsConnections.push(
            this._settings.connect('changed::refresh-interval', () => this._restartTimer()),
            this._settings.connect('changed::notification-filters', () => this._refresh()),
        );

        // Start polling
        this._refresh();
        this._startTimer();
    }

    _buildMenuLoading() {
        this.menu.removeAll();
        this.menu.addMenuItem(new PopupMenu.PopupMenuItem('Loading...', {reactive: false}));
    }

    _buildMenuError(msg) {
        this.menu.removeAll();
        const item = new PopupMenu.PopupMenuItem(msg, {reactive: false});
        this.menu.addMenuItem(item);
        this._addFooter();
    }

    _buildMenu(categories) {
        // Skip rebuild if menu is currently open to avoid visual disruption
        if (this.menu.isOpen) return;

        this.menu.removeAll();

        let totalPRs = 0;

        for (const {key, label, icon} of CATEGORY_META) {
            const prs = categories[key];
            if (!prs || prs.length === 0) continue;

            totalPRs += prs.length;

            const categoryItem = new PopupMenu.PopupSubMenuMenuItem(`${icon} ${label} (${prs.length})`);
            this.menu.addMenuItem(categoryItem);

            for (const pr of prs) {
                const ciIcon = CI_ICONS[pr.ciStatus] || CI_ICONS.none;
                const prItem = new PopupMenu.PopupMenuItem(
                    `${ciIcon} ${pr.repoName}: ${pr.title}`
                );
                prItem.connect('activate', () => {
                    Gio.AppInfo.launch_default_for_uri(pr.url, null);
                });
                categoryItem.menu.addMenuItem(prItem);

            }
        }

        if (totalPRs === 0) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                'No open PRs', {reactive: false}
            ));
        }

        this._addFooter();
    }

    _addFooter() {
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh Now');
        refreshItem.connect('activate', () => this._refresh());
        this.menu.addMenuItem(refreshItem);

        const prefsItem = new PopupMenu.PopupMenuItem('Preferences');
        prefsItem.connect('activate', () => {
            this._extension.openPreferences();
        });
        this.menu.addMenuItem(prefsItem);
    }

    _updateBadge(count) {
        if (count > 0) {
            this._badge.text = count > 99 ? '99+' : `${count}`;
            this._badge.show();
        } else {
            this._badge.hide();
        }
    }

    async _getToken() {
        const token = await Secret.password_lookup(
            SECRET_SCHEMA,
            {application: 'github-pr-status'},
            null,
        );
        return token;
    }

    async _refresh() {
        let token;
        try {
            token = await this._getToken();
        } catch (e) {
            console.error(`[GitHub PR Status] Failed to read token: ${e.message}`);
            this._buildMenuError('Failed to read token from keyring');
            return;
        }

        if (!token) {
            this._buildMenuError('No token configured \u2014 open Preferences');
            this._updateBadge(0);
            return;
        }

        try {
            const {categories} = await this._client.fetchPullRequests(token);
            this._lastCategories = categories;
            this._buildMenu(categories);
        } catch (e) {
            console.error(`[GitHub PR Status] PR fetch failed: ${e.message}`);
            if (!this._lastCategories) {
                this._buildMenuError(`Error: ${e.message.slice(0, 80)}`);
            }
        }

        try {
            const filters = this._settings.get_strv('notification-filters');
            const count = await this._client.fetchNotifications(token, filters);
            if (count >= 0) {
                this._lastNotificationCount = count;
                this._updateBadge(count);
            }
        } catch (e) {
            console.error(`[GitHub PR Status] Notification fetch failed: ${e.message}`);
        }
    }

    _startTimer() {
        const interval = this._settings.get_int('refresh-interval');
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _restartTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
        this._startTimer();
    }

    destroy() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }

        for (const id of this._settingsConnections)
            this._settings.disconnect(id);
        this._settingsConnections = [];

        this._client?.destroy();
        this._client = null;

        super.destroy();
    }
});

export default class GitHubPRStatusExtension extends Extension {
    enable() {
        this._button = new GitHubPRButton(this);
        Main.panel.addToStatusArea(this.uuid, this._button);
    }

    disable() {
        this._button?.destroy();
        this._button = null;
    }
}
