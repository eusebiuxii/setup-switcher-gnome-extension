import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as Display from './lib/displayConfig.js';
import * as Audio from './lib/audio.js';
import {loadSetups, saveSetups, newSetupId, LOGIN_LAST, LOGIN_NONE} from './lib/setups.js';

const COMMAND_HINT = 'Runs with /bin/sh, e.g. "steam steam://open/bigpicture" or "steam steam://close/bigpicture"';

export default class SetupSwitcherPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(720, 820);
        const controller = new PrefsController(window, this.getSettings());
        window.connect('close-request', () => {
            controller.destroy();
            return false;
        });
    }
}

class PrefsController {
    constructor(window, settings) {
        this._window = window;
        this._settings = settings;
        this._state = null;
        this._sinks = [];
        this._defaultSink = '';
        this._setupRows = [];
        this._expanded = new Set();
        this._selfWrite = false;

        window.add(this._buildSetupsPage());
        window.add(this._buildBehaviorPage());

        this._settingsId = settings.connect('changed::setups', () => {
            if (!this._selfWrite)
                this._rebuildSetups();
            this._rebuildLoginModel();
        });
        this._unwatch = Display.watchMonitorsChanged(() => this._refreshSafe());
        this._refreshSafe();
    }

    destroy() {
        this._settings.disconnect(this._settingsId);
        this._unwatch();
    }

    // ── Data ────────────────────────────────────────────────────────────

    _refreshSafe() {
        this._refresh().catch(e => console.error(`[setup-switcher] ${e}\n${e.stack}`));
    }

    async _refresh() {
        try {
            this._state = await Display.getCurrentState();
        } catch (e) {
            this._toast(`Could not read display configuration: ${e.message}`);
        }
        if (Audio.isAvailable()) {
            try {
                [this._sinks, this._defaultSink] = await Promise.all([
                    Audio.listSinks(), Audio.getDefaultSink(),
                ]);
            } catch (e) {
                console.warn(`[setup-switcher] ${e.message}`);
            }
        }
        this._updateCurrentLayout();
        this._rebuildNewAudioModel();
        this._rebuildSetups();
    }

    _setups() {
        return loadSetups(this._settings);
    }

    _writeSetups(setups, {rebuild = false} = {}) {
        this._selfWrite = true;
        try {
            saveSetups(this._settings, setups);
        } finally {
            this._selfWrite = false;
        }
        if (rebuild)
            this._rebuildSetups();
    }

    _updateSetup(id, change, opts) {
        const setups = this._setups();
        const setup = setups.find(s => s.id === id);
        if (!setup)
            return;
        change(setup);
        this._writeSetups(setups, opts);
    }

    _toast(title) {
        this._window.add_toast(new Adw.Toast({title, timeout: 4}));
    }

    _confirm(heading, body, actionLabel, destructive, onConfirm) {
        const dialog = new Adw.AlertDialog({heading, body});
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('ok', actionLabel);
        dialog.set_response_appearance('ok', destructive
            ? Adw.ResponseAppearance.DESTRUCTIVE
            : Adw.ResponseAppearance.SUGGESTED);
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');
        dialog.connect('response', (_d, response) => {
            if (response === 'ok')
                onConfirm();
        });
        dialog.present(this._window);
    }

    // ── Page 1: Setups ─────────────────────────────────────────────────

    _buildSetupsPage() {
        const page = new Adw.PreferencesPage({
            name: 'setups',
            title: 'Setups',
            icon_name: 'video-display-symbolic',
        });

        // Save current layout
        const saveGroup = new Adw.PreferencesGroup({
            title: 'Save Current Layout',
            description: 'Arrange your screens in Settings → Displays first (which screens are on, ' +
                'resolution, refresh rate, scale, position). Then name the layout, pick the audio ' +
                'output it should use and save it as a setup.',
        });
        page.add(saveGroup);

        this._currentRow = new Adw.ActionRow({
            title: 'Current screens',
            subtitle: 'Reading display configuration…',
            subtitle_lines: 0,
        });
        const displaysButton = new Gtk.Button({
            label: 'Display Settings',
            valign: Gtk.Align.CENTER,
        });
        displaysButton.connect('clicked', () => {
            try {
                Gio.Subprocess.new(['gnome-control-center', 'display'], Gio.SubprocessFlags.NONE);
            } catch (e) {
                this._toast(e.message);
            }
        });
        this._currentRow.add_suffix(displaysButton);
        saveGroup.add(this._currentRow);

        this._newName = new Adw.EntryRow({title: 'Setup name (e.g. Desk, TV, Couch gaming)'});
        saveGroup.add(this._newName);

        this._newAudio = new Adw.ComboRow({
            title: 'Audio output',
            subtitle: 'Sound switches to this output whenever the setup is applied',
        });
        this._newAudioChoices = [null];
        saveGroup.add(this._newAudio);

        if (!Audio.isAvailable()) {
            saveGroup.add(new Adw.ActionRow({
                title: 'Audio switching unavailable',
                subtitle: '"pactl" was not found. Install it (Fedora: pulseaudio-utils) to switch audio outputs.',
                css_classes: ['error'],
            }));
        }

        this._newOnEnter = new Adw.EntryRow({
            title: 'Command when switching to this setup (optional)',
            tooltip_text: COMMAND_HINT,
        });
        this._newOnLeave = new Adw.EntryRow({
            title: 'Command when switching away from this setup (optional)',
            tooltip_text: COMMAND_HINT,
        });
        saveGroup.add(this._newOnEnter);
        saveGroup.add(this._newOnLeave);

        const saveButton = new Adw.ButtonRow({
            title: 'Save Setup',
            start_icon_name: 'document-save-symbolic',
            css_classes: ['suggested-action'],
        });
        saveButton.connect('activated', () => this._saveNewSetup());
        saveGroup.add(saveButton);

        // Saved setups
        this._savedGroup = new Adw.PreferencesGroup({
            title: 'Saved Setups',
            description: 'Setups appear in this order in the Quick Settings menu.',
        });
        page.add(this._savedGroup);
        this._emptyRow = new Adw.ActionRow({
            title: 'No setups saved yet',
            css_classes: ['dim-label'],
        });

        return page;
    }

    _updateCurrentLayout() {
        if (!this._state)
            return;
        const layout = Display.captureLayout(this._state);
        const lines = layout.logicalMonitors.flatMap(lm => lm.monitors.map(m =>
            `${m.displayName} (${m.connector}): ${Display.describeMonitor(m, lm)}`));
        const off = this._state.monitors.filter(m =>
            !this._state.logicalMonitors.some(lm => lm.connectors.includes(m.connector)));
        lines.push(...off.map(m => `${m.displayName} (${m.connector}): off`));
        this._currentRow.subtitle = lines.join('\n');
    }

    /** Builds a combo of audio outputs; returns [row, choices] where choices[i] is the stored audio object. */
    _audioChoices(current) {
        const choices = [null, ...this._sinks.map(s => Audio.audioFromSink(s))];
        const labels = ["Don't change audio", ...this._sinks.map(s => s.description)];
        if (current?.sinkName && !this._sinks.some(s => s.name === current.sinkName)) {
            choices.push(current);
            labels.push(`${current.description} (not available right now)`);
        }
        let selected = 0;
        if (current?.sinkName)
            selected = Math.max(0, choices.findIndex(c => c?.sinkName === current.sinkName));
        return {choices, model: Gtk.StringList.new(labels), selected};
    }

    _rebuildNewAudioModel() {
        const previous = this._newAudioChoices[this._newAudio.selected];
        const defaultSink = this._sinks.find(s => s.name === this._defaultSink);
        const {choices, model, selected} = this._audioChoices(
            this._newAudioTouched ? previous : Audio.audioFromSink(defaultSink));
        this._newAudioChoices = choices;
        if (this._newAudioId)
            this._newAudio.disconnect(this._newAudioId);
        this._newAudio.model = model;
        this._newAudio.selected = selected;
        this._newAudioId = this._newAudio.connect('notify::selected', () => {
            this._newAudioTouched = true;
        });
    }

    async _saveNewSetup() {
        const name = this._newName.text.trim();
        if (!name) {
            this._toast('Give the setup a name first');
            this._newName.grab_focus();
            return;
        }
        const setups = this._setups();
        if (setups.some(s => s.name.toLowerCase() === name.toLowerCase())) {
            this._toast(`A setup called "${name}" already exists. Use "Overwrite" on it instead.`);
            return;
        }

        let state;
        try {
            state = await Display.getCurrentState();
        } catch (e) {
            this._toast(`Could not read display configuration: ${e.message}`);
            return;
        }

        const setup = {
            id: newSetupId(),
            name,
            layout: Display.captureLayout(state),
            audio: this._newAudioChoices[this._newAudio.selected] ?? null,
            onEnter: this._newOnEnter.text.trim(),
            onLeave: this._newOnLeave.text.trim(),
        };
        setups.push(setup);
        this._expanded.add(setup.id);
        this._writeSetups(setups, {rebuild: true});
        this._settings.set_string('last-setup', setup.id);

        this._newName.text = '';
        this._newOnEnter.text = '';
        this._newOnLeave.text = '';
        this._newAudioTouched = false;
        this._rebuildNewAudioModel();
        this._toast(`Saved "${name}"`);
    }

    _rebuildSetups() {
        for (const row of this._setupRows)
            this._savedGroup.remove(row);
        this._setupRows = [];

        const setups = this._setups();
        if (setups.length === 0) {
            this._savedGroup.add(this._emptyRow);
            this._setupRows.push(this._emptyRow);
            return;
        }
        setups.forEach((setup, index) => {
            const row = this._buildSetupRow(setup, index, setups.length);
            this._savedGroup.add(row);
            this._setupRows.push(row);
        });
    }

    _setupSubtitle(setup) {
        const parts = [Display.summarizeLayout(setup.layout)];
        parts.push(setup.audio ? `Audio: ${setup.audio.description}` : 'Audio unchanged');
        return parts.join(' · ');
    }

    _buildSetupRow(setup, index, count) {
        const row = new Adw.ExpanderRow({
            title: setup.name,
            subtitle: this._setupSubtitle(setup),
            expanded: this._expanded.has(setup.id),
        });
        row.connect('notify::expanded', () => {
            if (row.expanded)
                this._expanded.add(setup.id);
            else
                this._expanded.delete(setup.id);
        });

        if (this._state) {
            let status = null;
            if (Display.isLayoutActive(setup.layout, this._state))
                status = {label: 'Active', css: 'success'};
            else if (!Display.isLayoutAvailable(setup.layout, this._state))
                status = {label: 'Not connected', css: 'dim-label'};
            if (status) {
                row.add_suffix(new Gtk.Label({
                    label: status.label,
                    css_classes: [status.css, 'caption'],
                    valign: Gtk.Align.CENTER,
                }));
            }
        }

        // Name
        const nameRow = new Adw.EntryRow({title: 'Name', text: setup.name, show_apply_button: true});
        nameRow.connect('apply', () => {
            const name = nameRow.text.trim();
            if (!name) {
                nameRow.text = setup.name;
                return;
            }
            setup.name = name;
            row.title = name;
            this._updateSetup(setup.id, s => (s.name = name));
            this._rebuildLoginModel();
        });
        row.add_row(nameRow);

        // Screens
        const connected = this._state ? Display.buildConfig(setup.layout, this._state) : null;
        for (const lm of setup.layout.logicalMonitors) {
            for (const m of lm.monitors) {
                const missing = connected?.problems.some(p => p.startsWith(m.displayName));
                row.add_row(new Adw.ActionRow({
                    title: `${m.displayName} (${m.connector})`,
                    subtitle: Display.describeMonitor(m, lm) + (missing ? ' · not available right now' : ''),
                    icon_name: 'video-display-symbolic',
                }));
            }
        }

        // Audio
        const {choices, model, selected} = this._audioChoices(setup.audio);
        const audioRow = new Adw.ComboRow({
            title: 'Audio output',
            subtitle: 'Sound switches to this output when the setup is applied',
            model,
            selected,
        });
        audioRow.connect('notify::selected', () => {
            const audio = choices[audioRow.selected] ?? null;
            setup.audio = audio;
            row.subtitle = this._setupSubtitle(setup);
            this._updateSetup(setup.id, s => (s.audio = audio));
        });
        row.add_row(audioRow);

        // Commands
        for (const [key, title] of [
            ['onEnter', 'Command when switching to this setup'],
            ['onLeave', 'Command when switching away from this setup'],
        ]) {
            const entry = new Adw.EntryRow({
                title,
                text: setup[key] ?? '',
                show_apply_button: true,
                tooltip_text: COMMAND_HINT,
            });
            entry.connect('apply', () => {
                const value = entry.text.trim();
                this._updateSetup(setup.id, s => (s[key] = value));
                this._toast('Command saved');
            });
            row.add_row(entry);
        }

        // Actions
        const actions = new Adw.ActionRow({title: 'Manage'});
        const button = (props, onClick) => {
            const b = new Gtk.Button({valign: Gtk.Align.CENTER, ...props});
            b.connect('clicked', onClick);
            actions.add_suffix(b);
            return b;
        };
        button({
            icon_name: 'go-up-symbolic',
            tooltip_text: 'Move up',
            sensitive: index > 0,
            css_classes: ['flat'],
        }, () => this._move(setup.id, -1));
        button({
            icon_name: 'go-down-symbolic',
            tooltip_text: 'Move down',
            sensitive: index < count - 1,
            css_classes: ['flat'],
        }, () => this._move(setup.id, 1));
        button({
            label: 'Overwrite…',
            tooltip_text: 'Replace this setup\'s screen layout with the current one',
        }, () => this._confirm(
            `Overwrite "${setup.name}"?`,
            'Its screen layout will be replaced with your current screens. Audio and commands are kept.',
            'Overwrite', false, () => this._overwrite(setup.id)));
        button({
            label: 'Delete…',
            css_classes: ['destructive-action'],
        }, () => this._confirm(
            `Delete "${setup.name}"?`,
            'This cannot be undone.',
            'Delete', true, () => this._delete(setup.id)));
        row.add_row(actions);

        return row;
    }

    _move(id, delta) {
        const setups = this._setups();
        const i = setups.findIndex(s => s.id === id);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= setups.length)
            return;
        [setups[i], setups[j]] = [setups[j], setups[i]];
        this._writeSetups(setups, {rebuild: true});
    }

    async _overwrite(id) {
        try {
            const state = await Display.getCurrentState();
            const layout = Display.captureLayout(state);
            this._updateSetup(id, s => (s.layout = layout), {rebuild: true});
            this._settings.set_string('last-setup', id);
            this._toast('Setup overwritten with the current layout');
        } catch (e) {
            this._toast(`Could not read display configuration: ${e.message}`);
        }
    }

    _delete(id) {
        const setups = this._setups().filter(s => s.id !== id);
        this._expanded.delete(id);
        this._writeSetups(setups, {rebuild: true});
        if (this._settings.get_string('login-setup') === id)
            this._settings.set_string('login-setup', LOGIN_NONE);
        if (this._settings.get_string('last-setup') === id)
            this._settings.set_string('last-setup', '');
    }

    // ── Page 2: Behavior ───────────────────────────────────────────────

    _buildBehaviorPage() {
        const page = new Adw.PreferencesPage({
            name: 'behavior',
            title: 'Behavior',
            icon_name: 'preferences-system-symbolic',
        });

        const loginGroup = new Adw.PreferencesGroup({
            title: 'At Login',
            description: 'Applied when your session starts. Setups whose screens are not connected are skipped.',
        });
        page.add(loginGroup);

        this._loginRow = new Adw.ComboRow({
            title: 'Setup at login',
            subtitle: '"Remember last used setup" restores the setup you were using when you logged out or shut down',
        });
        loginGroup.add(this._loginRow);
        this._rebuildLoginModel();

        const runAtLogin = new Adw.SwitchRow({
            title: 'Run setup commands at login',
            subtitle: 'Also run the "switching to" command (e.g. start Steam Big Picture) of the login setup',
        });
        this._settings.bind('run-commands-at-login', runAtLogin, 'active', Gio.SettingsBindFlags.DEFAULT);
        loginGroup.add(runAtLogin);

        const switchGroup = new Adw.PreferencesGroup({title: 'Switching'});
        page.add(switchGroup);

        const confirm = new Adw.SwitchRow({
            title: 'Ask to keep changes',
            subtitle: 'Show the "Keep these display settings?" dialog after switching. If you don\'t ' +
                'confirm, the screens revert automatically, and audio and commands are not run.',
        });
        this._settings.bind('confirm-changes', confirm, 'active', Gio.SettingsBindFlags.DEFAULT);
        switchGroup.add(confirm);

        const hide = new Adw.SwitchRow({
            title: 'Hide unavailable setups',
            subtitle: 'Hide setups whose screens are not connected instead of greying them out',
        });
        this._settings.bind('hide-unavailable', hide, 'active', Gio.SettingsBindFlags.DEFAULT);
        switchGroup.add(hide);

        return page;
    }

    _rebuildLoginModel() {
        const setups = this._setups();
        const values = [LOGIN_NONE, LOGIN_LAST, ...setups.map(s => s.id)];
        const labels = ["Don't change", 'Remember last used setup', ...setups.map(s => s.name)];

        if (this._loginId)
            this._loginRow.disconnect(this._loginId);
        this._loginRow.model = Gtk.StringList.new(labels);
        const current = this._settings.get_string('login-setup');
        this._loginRow.selected = Math.max(0, values.indexOf(current));
        this._loginId = this._loginRow.connect('notify::selected', () => {
            this._settings.set_string('login-setup', values[this._loginRow.selected] ?? LOGIN_NONE);
        });
    }
}
