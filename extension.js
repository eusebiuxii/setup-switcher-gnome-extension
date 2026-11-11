import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Display from './lib/displayConfig.js';
import * as Audio from './lib/audio.js';
import {loadSetups, LOGIN_LAST, LOGIN_NONE} from './lib/setups.js';

const ICON_NAME = 'video-display-symbolic';
const LOG_PREFIX = '[setup-switcher]';

function wait(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

/**
 * Applies setups: display layout, then (once the change is kept) the
 * previous setup's "on leave" command, the audio output and the new setup's
 * "on enter" command.
 */
class SetupManager {
    constructor(extension) {
        this._extension = extension;
        this._settings = extension.getSettings();
        this._injections = new InjectionManager();
        this._confirmResolve = null;
        this._busy = false;
        this._destroyed = false;

        // Find out whether the user kept or reverted the display change.
        // GNOME Shell's DisplayChangeDialog calls complete_display_change().
        const manager = this;
        this._injections.overrideMethod(Shell.WM.prototype, 'complete_display_change',
            original => function (ok) {
                manager._onDisplayChangeCompleted(ok);
                return original.call(this, ok);
            });
    }

    destroy() {
        this._destroyed = true;
        this._injections.clear();
        this._onDisplayChangeCompleted(false);
    }

    get busy() {
        return this._busy;
    }

    _onDisplayChangeCompleted(ok) {
        const resolve = this._confirmResolve;
        this._confirmResolve = null;
        resolve?.(ok);
    }

    /** Applies with GNOME's keep/revert dialog. Resolves to true if kept. */
    async _applyConfirmed(layout, state) {
        const wm = global.window_manager;
        let requested = false;
        const signalId = wm.connect('confirm-display-change', () => {
            requested = true;
        });
        const decision = new Promise(resolve => {
            this._confirmResolve = resolve;
        });

        try {
            await Display.applyLayout(layout, state, Display.ApplyMethod.PERSISTENT);
            await wait(300);
        } catch (e) {
            this._confirmResolve = null;
            throw e;
        } finally {
            wm.disconnect(signalId);
        }

        // No dialog was requested: nothing to confirm, the change is kept.
        if (!requested) {
            this._confirmResolve = null;
            return true;
        }

        // Mutter reverts on its own when its timeout expires without the
        // dialog reporting back, so give up a little after that.
        const timeout = global.backend.get_monitor_manager().get_display_configuration_timeout();
        return Promise.race([
            decision,
            wait((timeout + 3) * 1000).then(() => {
                this._confirmResolve = null;
                return false;
            }),
        ]);
    }

    /** Id of the setup matching the current screens, or null. */
    activeSetupId(state, setups = loadSetups(this._settings)) {
        return setups.find(s => Display.isLayoutActive(s.layout, state))?.id ?? null;
    }

    async switchTo(id, {atLogin = false} = {}) {
        if (this._busy)
            return;
        const setups = loadSetups(this._settings);
        const setup = setups.find(s => s.id === id);
        if (!setup)
            return;

        this._busy = true;
        try {
            const state = await Display.getCurrentState();
            const previousId = this.activeSetupId(state, setups) ?? this._settings.get_string('last-setup');
            const previous = setups.find(s => s.id === previousId) ?? null;

            if (!Display.isLayoutActive(setup.layout, state)) {
                let kept = true;
                if (!atLogin && this._settings.get_boolean('confirm-changes'))
                    kept = await this._applyConfirmed(setup.layout, state);
                else
                    await Display.applyLayout(setup.layout, state, Display.ApplyMethod.TEMPORARY);

                if (!kept || this._destroyed) {
                    console.log(`${LOG_PREFIX} Switch to "${setup.name}" was reverted`);
                    return;
                }
            }

            this._settings.set_string('last-setup', setup.id);
            const runCommands = !atLogin || this._settings.get_boolean('run-commands-at-login');

            // At login there is nothing to "leave", so only run on-enter.
            if (runCommands && !atLogin && previous && previous.id !== setup.id && previous.onLeave?.trim())
                this._runCommand(previous.onLeave, `${previous.name} (on leave)`);

            if (setup.audio) {
                try {
                    await Audio.applyAudio(setup.audio);
                } catch (e) {
                    this._notifyError(`Could not switch audio for "${setup.name}"`, e.message);
                }
            }

            if (runCommands && setup.onEnter?.trim() && !this._destroyed)
                this._runCommand(setup.onEnter, `${setup.name} (on enter)`);
        } catch (e) {
            console.error(`${LOG_PREFIX} ${e}`);
            this._notifyError(`Could not switch to "${setup.name}"`, e.message);
        } finally {
            this._busy = false;
        }
    }

    async applyLoginSetup() {
        const choice = this._settings.get_string('login-setup');
        if (choice === LOGIN_NONE)
            return;
        const id = choice === LOGIN_LAST ? this._settings.get_string('last-setup') : choice;
        if (!id)
            return;

        const setup = loadSetups(this._settings).find(s => s.id === id);
        if (!setup)
            return;
        const state = await Display.getCurrentState();
        const {problems} = Display.buildConfig(setup.layout, state);
        if (problems.length) {
            console.log(`${LOG_PREFIX} Login setup "${setup.name}" unavailable: ${problems.join('; ')}`);
            return;
        }
        await this.switchTo(id, {atLogin: true});
    }

    _runCommand(command, label) {
        console.log(`${LOG_PREFIX} Running command for ${label}: ${command}`);
        try {
            Util.spawn(['/bin/sh', '-c', command]);
        } catch (e) {
            this._notifyError(`Command for ${label} failed`, e.message);
        }
    }

    _notifyError(title, body) {
        Main.notifyError(title, body);
    }
}

const SetupToggle = GObject.registerClass(
class SetupToggle extends QuickMenuToggle {
    _init(extension, manager) {
        super._init({
            title: 'Display Setup',
            iconName: ICON_NAME,
            toggleMode: false,
            menuButtonAccessibleName: 'Open display setups menu',
        });
        this._extension = extension;
        this._manager = manager;
        this._settings = extension.getSettings();
        this._syncSerial = 0;

        this.menu.setHeader(ICON_NAME, 'Display Setup');
        this._section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._section);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Setup Switcher Settings', () => {
            Main.panel.closeQuickSettings();
            extension.openPreferences();
        });

        // Clicking the tile itself opens the list of setups.
        this.connect('clicked', () => this.menu.open());

        this._settingsChangedId = this._settings.connect('changed', () => this.sync());
        this._unwatchMonitors = Display.watchMonitorsChanged(() => this.sync());
        this._destroyed = false;
        this.connect('destroy', () => {
            this._destroyed = true;
            this._settings.disconnect(this._settingsChangedId);
            this._unwatchMonitors();
        });
        this.sync();
    }

    async sync() {
        const serial = ++this._syncSerial;
        let state;
        try {
            state = await Display.getCurrentState();
        } catch (e) {
            console.error(`${LOG_PREFIX} ${e}`);
            return;
        }
        // A newer sync started meanwhile, or we were destroyed.
        if (serial !== this._syncSerial || this._destroyed)
            return;

        const setups = loadSetups(this._settings);
        const activeId = this._manager.activeSetupId(state, setups);
        const hideUnavailable = this._settings.get_boolean('hide-unavailable');

        // Keep "remember last setup" accurate when the screens were changed
        // by other means (e.g. GNOME Settings) to match a saved setup.
        if (activeId && activeId !== this._settings.get_string('last-setup') && !this._manager.busy)
            this._settings.set_string('last-setup', activeId);

        this._section.removeAll();
        for (const setup of setups) {
            const available = Display.isLayoutAvailable(setup.layout, state);
            if (!available && hideUnavailable)
                continue;

            const item = new PopupMenu.PopupMenuItem(setup.name);
            if (!available) {
                item.setSensitive(false);
                item.add_child(new St.Label({
                    text: 'Not connected',
                    style_class: 'setup-switcher-unavailable',
                    x_expand: true,
                    x_align: Clutter.ActorAlign.END,
                }));
            }
            item.setOrnament(setup.id === activeId
                ? PopupMenu.Ornament.CHECK
                : PopupMenu.Ornament.NONE);
            item.connect('activate', () => {
                Main.panel.closeQuickSettings();
                this._manager.switchTo(setup.id);
            });
            this._section.addMenuItem(item);
        }

        if (setups.length === 0) {
            const item = new PopupMenu.PopupMenuItem('No setups saved yet. Open settings to save one.');
            item.connect('activate', () => {
                Main.panel.closeQuickSettings();
                this._extension.openPreferences();
            });
            this._section.addMenuItem(item);
        }

        const active = setups.find(s => s.id === activeId);
        this.subtitle = active ? active.name : 'Custom';
        this.checked = !!active;
    }
});

const SetupIndicator = GObject.registerClass(
class SetupIndicator extends SystemIndicator {
    _init(extension, manager) {
        super._init();
        this.quickSettingsItems.push(new SetupToggle(extension, manager));
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

export default class SetupSwitcherExtension extends Extension {
    enable() {
        this._manager = new SetupManager(this);
        this._indicator = new SetupIndicator(this, this._manager);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        // Apply the login setup only when the session starts, not when the
        // extension is re-enabled (e.g. after unlocking the screen).
        if (Main.layoutManager._startingUp) {
            this._startupId = Main.layoutManager.connect('startup-complete', () => {
                Main.layoutManager.disconnect(this._startupId);
                this._startupId = 0;
                this._loginTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                    this._loginTimeoutId = 0;
                    this._manager?.applyLoginSetup().catch(e => console.error(`${LOG_PREFIX} ${e}`));
                    return GLib.SOURCE_REMOVE;
                });
            });
        }
    }

    disable() {
        if (this._startupId) {
            Main.layoutManager.disconnect(this._startupId);
            this._startupId = 0;
        }
        if (this._loginTimeoutId) {
            GLib.source_remove(this._loginTimeoutId);
            this._loginTimeoutId = 0;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._manager?.destroy();
        this._manager = null;
    }
}
