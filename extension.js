import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {BarLevel} from 'resource:///org/gnome/shell/ui/barLevel.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {formatClockTime, formatReset, percentLeft, usageLevel} from './format.js';
import {STATUS_PAGE_URL, fetchServiceStatus} from './status.js';
import {
    CREDENTIALS_PATH,
    RateLimitedError,
    SignInExpiredError,
    UsageError,
    fetchUsage,
    readSignIn,
    renewSignIn,
} from './usage.js';

const REFRESH_INTERVAL_SECONDS = 5 * 60;
const REFRESH_ON_OPEN_AFTER_MS = 60 * 1000;
const HTTP_TIMEOUT_SECONDS = 15;
const RENEWAL_COOLDOWN_MS = 5 * 60 * 1000;
// In case the server rejected a token that is still valid.
const REJECTED_TOKEN_RETRY_MS = 60 * 60 * 1000;
const DIM_OPACITY = 180;

function isCancelled(error) {
    return error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

function wrappedLabel(text, props = {}) {
    const label = new St.Label({text, ...props});
    label.clutter_text.line_wrap = true;
    return label;
}

const LimitItem = GObject.registerClass(
    class LimitItem extends PopupMenu.PopupBaseMenuItem {
        constructor(limit, now, use24h) {
            super({reactive: false, can_focus: false});

            const box = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'claude-usage-limit',
                x_expand: true,
            });
            this.add_child(box);

            const left = percentLeft(limit.utilization);
            const header = new St.BoxLayout();
            header.add_child(new St.Label({text: limit.title, style_class: 'claude-usage-title', x_expand: true}));
            header.add_child(new St.Label({text: `${left}% left`}));
            box.add_child(header);

            box.add_child(
                new BarLevel({
                    style_class: `claude-usage-bar ${usageLevel(left)}`,
                    value: left / 100,
                    x_expand: true,
                })
            );
            box.add_child(
                new St.Label({
                    text: formatReset(limit.resetsAt, now, use24h),
                    style_class: 'claude-usage-reset',
                    opacity: DIM_OPACITY,
                })
            );
        }
    }
);

const Indicator = GObject.registerClass(
    class Indicator extends PanelMenu.Button {
        constructor(extension) {
            super(0.5, 'Claude Usage');

            this._panelBox = new St.BoxLayout({style_class: 'claude-usage-panel'});
            this.add_child(this._panelBox);

            this._limitsSection = new PopupMenu.PopupMenuSection();
            this.menu.addMenuItem(this._limitsSection);
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._statusItem = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
            this._statusItem.label.add_style_class_name('claude-usage-status');
            this._statusItem.label.clutter_text.line_wrap = true;
            this.menu.addMenuItem(this._statusItem);
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._serviceItem = new PopupMenu.PopupBaseMenuItem();
            this._serviceBox = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'claude-usage-service',
                x_expand: true,
            });
            this._serviceItem.add_child(this._serviceBox);
            this._serviceItem.connect('activate', () => {
                Gio.AppInfo.launch_default_for_uri(STATUS_PAGE_URL, global.create_app_launch_context(0, -1));
            });
            this.menu.addMenuItem(this._serviceItem);

            this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
            this._session = new Soup.Session({user_agent: extension.uuid, timeout: HTTP_TIMEOUT_SECONDS});
            this._cancellable = new Gio.Cancellable();
            this._limits = null;
            this._updatedAt = null;
            this._error = null;
            this._refreshing = false;
            this._refreshQueued = false;
            this._renewing = false;
            this._lastRenewalAt = -Infinity;
            // {token, until, error}: the access token the server last rejected or
            // rate limited, which isn't sent again until `until`.
            this._blocked = null;
            this._serviceStatus = null;
            this._serviceCheckedAt = null;
            this._serviceError = null;
            this._checkingService = false;

            this._credentialsMonitor = Gio.File.new_for_path(CREDENTIALS_PATH).monitor_file(
                Gio.FileMonitorFlags.NONE,
                null
            );
            this._credentialsMonitor.connect('changed', (_monitor, file, _otherFile, event) => {
                // Claude Code replaces the file when it renews the sign-in, and deletes it on sign-out.
                // Replacing the file also reports it as deleted, but it exists by then.
                if (
                    event === Gio.FileMonitorEvent.CHANGES_DONE_HINT ||
                    (event === Gio.FileMonitorEvent.DELETED && !file.query_exists(null))
                ) {
                    this._refresh();
                }
            });

            this.menu.connect('open-state-changed', (_menu, open) => {
                if (!open) {
                    return;
                }
                this._render();
                this._renderServiceStatus();
                if (this._updatedAt === null || Date.now() - this._updatedAt > REFRESH_ON_OPEN_AFTER_MS) {
                    this._refresh();
                }
                if (this._serviceCheckedAt === null || Date.now() - this._serviceCheckedAt > REFRESH_ON_OPEN_AFTER_MS) {
                    this._refreshServiceStatus();
                }
            });

            this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_INTERVAL_SECONDS, () => {
                this._refresh();
                this._refreshServiceStatus();
                return GLib.SOURCE_CONTINUE;
            });

            this._render();
            this._refresh();
            this._renderServiceStatus();
            this._refreshServiceStatus();
        }

        async _refreshServiceStatus() {
            if (this._checkingService) {
                return;
            }
            this._checkingService = true;
            try {
                this._serviceStatus = await fetchServiceStatus(this._session, this._cancellable);
                this._serviceCheckedAt = Date.now();
                this._serviceError = null;
            } catch (e) {
                if (isCancelled(e)) {
                    return;
                }
                console.error(e);
                this._serviceError = e;
            } finally {
                this._checkingService = false;
            }
            this._renderServiceStatus();
        }

        _renderServiceStatus() {
            const labels = [];
            if (this._serviceStatus !== null) {
                labels.push(wrappedLabel(this._serviceStatus.description));
                for (const incident of this._serviceStatus.incidents) {
                    labels.push(wrappedLabel(incident, {style_class: 'claude-usage-incident', opacity: DIM_OPACITY}));
                }
            }
            if (this._serviceError !== null) {
                let text = `Couldn't check the Claude status: ${this._serviceError.message}.`;
                if (this._serviceStatus !== null) {
                    const now = Date.now();
                    const use24h = this._interfaceSettings.get_string('clock-format') === '24h';
                    text += ` Showing the status from ${formatClockTime(this._serviceCheckedAt, now, use24h)}.`;
                }
                labels.push(wrappedLabel(text));
            }
            if (labels.length === 0) {
                labels.push(wrappedLabel('Checking the Claude status…'));
            }

            this._serviceBox.destroy_all_children();
            for (const label of labels) {
                this._serviceBox.add_child(label);
            }
            this._serviceItem.label_actor = labels[0];
        }

        async _refresh() {
            // A renewal ends with a refresh of its own.
            if (this._renewing) {
                return;
            }
            if (this._refreshing) {
                this._refreshQueued = true;
                return;
            }
            this._refreshing = true;
            try {
                this._limits = await this._fetch();
                this._updatedAt = Date.now();
                this._error = null;
            } catch (e) {
                if (isCancelled(e)) {
                    return;
                }
                if (!(e instanceof UsageError)) {
                    console.error(e);
                }
                this._error = e;
            } finally {
                this._refreshing = false;
            }
            this._render();

            if (this._refreshQueued) {
                this._refreshQueued = false;
                this._refresh();
            }
        }

        async _fetch() {
            const signIn = await readSignIn(this._cancellable);
            const blocked = this._blocked;
            if (blocked !== null && signIn.accessToken === blocked.token && Date.now() < blocked.until) {
                if (blocked.error instanceof SignInExpiredError) {
                    this._renewIfDue();
                }
                throw blocked.error;
            }

            try {
                return await fetchUsage(this._session, signIn, this._cancellable);
            } catch (e) {
                if (e instanceof SignInExpiredError) {
                    this._blocked = {token: signIn.accessToken, until: Date.now() + REJECTED_TOKEN_RETRY_MS, error: e};
                    this._renewIfDue();
                } else if (e instanceof RateLimitedError && e.retryAfterMs !== null) {
                    this._blocked = {token: signIn.accessToken, until: Date.now() + e.retryAfterMs, error: e};
                }
                throw e;
            }
        }

        _renewIfDue() {
            if (Date.now() - this._lastRenewalAt >= RENEWAL_COOLDOWN_MS) {
                this._renewSignIn();
            }
        }

        async _renewSignIn() {
            this._lastRenewalAt = Date.now();
            this._renewing = true;
            try {
                await renewSignIn(this._cancellable);
            } catch (e) {
                if (isCancelled(e)) {
                    return;
                }
                console.error(e);
            } finally {
                this._renewing = false;
            }
            this._refresh();
        }

        _render() {
            const now = Date.now();
            const use24h = this._interfaceSettings.get_string('clock-format') === '24h';

            this._limitsSection.removeAll();
            for (const limit of this._limits ?? []) {
                this._limitsSection.addMenuItem(new LimitItem(limit, now, use24h));
            }

            this._renderPanel();

            if (this._renewing) {
                this._statusItem.label.text = 'Renewing the Claude Code sign-in…';
            } else if (this._error !== null) {
                this._statusItem.label.text = this._errorText(now, use24h);
            } else if (this._limits === null) {
                this._statusItem.label.text = 'Loading…';
            } else if (this._limits.length === 0) {
                this._statusItem.label.text = 'No usage limits reported';
            } else {
                this._statusItem.label.text = `Updated ${formatClockTime(this._updatedAt, now, use24h)}`;
            }
        }

        _renderPanel() {
            this._panelBox.destroy_all_children();
            const shown = (this._limits ?? []).filter(limit => limit.panelLabel !== null);
            this._panelBox.opacity = this._error !== null && shown.length > 0 ? DIM_OPACITY : 255;
            if (shown.length === 0) {
                let text = 'Claude';
                if (this._error !== null) {
                    text += ' !';
                } else if (this._limits === null) {
                    text += ' …';
                }
                this._panelBox.add_child(new St.Label({text, y_align: Clutter.ActorAlign.CENTER}));
                return;
            }

            for (const limit of shown) {
                const left = percentLeft(limit.utilization);
                const box = new St.BoxLayout({style_class: 'claude-usage-panel-limit'});
                box.add_child(
                    new St.Label({
                        text: limit.panelLabel,
                        style_class: 'claude-usage-panel-label',
                        y_align: Clutter.ActorAlign.CENTER,
                        opacity: DIM_OPACITY,
                    })
                );
                box.add_child(
                    new St.Label({
                        text: `${left}%`,
                        style_class: `claude-usage-panel-percent ${usageLevel(left)}`,
                        y_align: Clutter.ActorAlign.CENTER,
                    })
                );
                this._panelBox.add_child(box);
            }
        }

        _errorText(now, use24h) {
            const error = this._error;
            let text = error instanceof UsageError ? error.message : `Couldn't fetch usage: ${error.message}.`;
            if (error instanceof RateLimitedError && error === this._blocked?.error && this._blocked.until > now) {
                text += ` Trying again at ${formatClockTime(this._blocked.until, now, use24h)}.`;
            }
            if (this._updatedAt !== null) {
                text += ` Showing usage from ${formatClockTime(this._updatedAt, now, use24h)}.`;
            }
            return text;
        }

        _onDestroy() {
            GLib.source_remove(this._timerId);
            this._cancellable.cancel();
            this._credentialsMonitor.cancel();
            super._onDestroy();
        }
    }
);

export default class ClaudeUsageExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
    }
}
