import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
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
        this._window.add_toast(new Adw.Toast({title, timeout: 4, use_markup: false}));
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
            description: 'Arrange your screens in Display Settings, then save them as a setup.',
        });
        page.add(saveGroup);

        this._currentRow = new Adw.ExpanderRow({
            title: 'Current screens',
            subtitle: 'Reading display configuration…',
            use_markup: false,
        });
        this._currentScreenRows = [];
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

        this._newName = new Adw.EntryRow({title: 'Name (e.g. Desk, TV, Couch gaming)'});
        saveGroup.add(this._newName);

        this._newAudio = new Adw.ComboRow({title: 'Audio output'});
        this._newAudioChoices = [null];
        saveGroup.add(this._newAudio);

        if (!Audio.isAvailable()) {
            saveGroup.add(new Adw.ActionRow({
                title: 'Audio switching unavailable',
                subtitle: '"pactl" was not found. Install it (Fedora: pulseaudio-utils) to switch audio outputs.',
                css_classes: ['error'],
            }));
        }

        const commands = new Adw.ExpanderRow({
            title: 'Commands',
            subtitle: 'Optional',
        });
        this._newOnEnter = new Adw.EntryRow({title: 'On switching to', tooltip_text: COMMAND_HINT});
        this._newOnLeave = new Adw.EntryRow({title: 'On switching away', tooltip_text: COMMAND_HINT});
        commands.add_row(this._newOnEnter);
        commands.add_row(this._newOnLeave);
        saveGroup.add(commands);

        const saveButton = new Gtk.Button({
            child: new Adw.ButtonContent({
                label: 'Save Setup',
                icon_name: 'document-save-symbolic',
            }),
            css_classes: ['suggested-action', 'pill'],
            height_request: 48,
            margin_top: 12,
        });
        saveButton.connect('clicked', () => this._saveNewSetup());
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
        for (const r of this._currentScreenRows)
            this._currentRow.remove(r);
        this._currentScreenRows = [];

        const layout = Display.captureLayout(this._state);
        const on = layout.logicalMonitors.flatMap(lm => lm.monitors.map(m =>
            this._screenRow(m, Display.describeMonitor(m, lm))));
        const off = this._state.monitors
            .filter(m => !this._state.logicalMonitors.some(lm => lm.connectors.includes(m.connector)))
            .map(m => this._screenRow(m, 'Off', true));
        for (const r of [...on, ...off]) {
            this._currentRow.add_row(r);
            this._currentScreenRows.push(r);
        }
        this._currentRow.subtitle = this._screenCount(on.length) +
            (off.length ? ` on · ${off.length} off` : '');
    }

    _screenCount(n) {
        return `${n} screen${n === 1 ? '' : 's'}`;
    }

    _screenRow(monitor, details, dim = false) {
        return new Adw.ActionRow({
            title: monitor.displayName,
            subtitle: details,
            tooltip_text: monitor.connector,
            icon_name: 'video-display-symbolic',
            css_classes: dim ? ['dim-label'] : [],
            use_markup: false,
        });
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
        const count = Display.layoutMonitors(setup.layout).length;
        return [
            this._screenCount(count),
            setup.audio ? setup.audio.description : 'Audio unchanged',
        ].join(' · ');
    }

    _buildSetupRow(setup, index, count) {
        const row = new Adw.ExpanderRow({
            title: setup.name,
            subtitle: this._setupSubtitle(setup),
            expanded: this._expanded.has(setup.id),
            use_markup: false,
        });
        this._makeDraggable(row, setup);
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
                row.add_row(this._screenRow(m,
                    Display.describeMonitor(m, lm) + (missing ? ' · not connected' : ''), missing));
            }
        }

        // Audio
        const {choices, model, selected} = this._audioChoices(setup.audio);
        const audioRow = new Adw.ComboRow({
            title: 'Audio output',
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
            ['onEnter', 'Command on switching to'],
            ['onLeave', 'Command on switching away'],
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

    /** Adds a drag handle to a setup row and lets other setup rows be dropped onto it. */
    _makeDraggable(row, setup) {
        const handle = new Gtk.Image({
            icon_name: 'list-drag-handle-symbolic',
            tooltip_text: 'Drag to reorder',
            css_classes: ['dim-label'],
            cursor: Gdk.Cursor.new_from_name('grab', null),
        });
        row.add_prefix(handle);

        const source = new Gtk.DragSource({actions: Gdk.DragAction.MOVE});
        source.connect('prepare', () => Gdk.ContentProvider.new_for_value(setup.id));
        source.connect('drag-begin', (_src, drag) => {
            const icon = Gtk.DragIcon.get_for_drag(drag);
            const preview = new Adw.PreferencesGroup({width_request: row.get_width()});
            preview.add(new Adw.ActionRow({title: setup.name, use_markup: false}));
            icon.child = preview;
            drag.set_hotspot(16, 16);
        });
        handle.add_controller(source);

        // Pressing the handle collapses the row. The press is claimed so the
        // row header doesn't also toggle it open; grouping with the drag
        // source keeps dragging working.
        const press = new Gtk.GestureClick();
        press.group(source);
        press.connect('pressed', () => {
            press.set_state(Gtk.EventSequenceState.CLAIMED);
            row.expanded = false;
        });
        handle.add_controller(press);

        const target = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE);
        target.connect('drop', (_t, draggedId) => {
            if (draggedId === setup.id)
                return false;
            // Rebuilding destroys this row, so do it after the drop finishes.
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._moveTo(draggedId, setup.id);
                return GLib.SOURCE_REMOVE;
            });
            return true;
        });
        row.add_controller(target);
    }

    _moveTo(id, targetId) {
        const setups = this._setups();
        const from = setups.findIndex(s => s.id === id);
        const to = setups.findIndex(s => s.id === targetId);
        if (from < 0 || to < 0 || from === to)
            return;
        const [moved] = setups.splice(from, 1);
        setups.splice(to, 0, moved);
        this._writeSetups(setups, {rebuild: true});
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

        const loginGroup = new Adw.PreferencesGroup({title: 'At Login'});
        page.add(loginGroup);

        this._loginRow = new Adw.ExpanderRow({title: 'Setup at login', use_markup: false});
        this._loginOptionRows = [];
        loginGroup.add(this._loginRow);
        this._rebuildLoginModel();

        const runAtLogin = new Adw.SwitchRow({
            title: 'Run setup commands at login',
            subtitle: 'Also run the setup\'s "switching to" command',
        });
        this._settings.bind('run-commands-at-login', runAtLogin, 'active', Gio.SettingsBindFlags.DEFAULT);
        loginGroup.add(runAtLogin);

        const switchGroup = new Adw.PreferencesGroup({title: 'Switching'});
        page.add(switchGroup);

        const confirm = new Adw.SwitchRow({
            title: 'Ask to keep changes when switching',
            subtitle: 'Screens revert if you don\'t confirm',
        });
        this._settings.bind('confirm-changes', confirm, 'active', Gio.SettingsBindFlags.DEFAULT);
        switchGroup.add(confirm);

        const hide = new Adw.SwitchRow({
            title: 'Hide unavailable setups',
            subtitle: 'Instead of greying out setups whose screens aren\'t connected',
        });
        this._settings.bind('hide-unavailable', hide, 'active', Gio.SettingsBindFlags.DEFAULT);
        switchGroup.add(hide);

        return page;
    }

    _rebuildLoginModel() {
        const options = [
            {value: LOGIN_NONE, title: "Don't change", subtitle: 'Keep the screens GNOME starts with'},
            {value: LOGIN_LAST, title: 'Remember last used', subtitle: 'Restore the setup in use when you logged out'},
            ...this._setups().map(s => ({value: s.id, title: s.name, subtitle: null})),
        ];
        const stored = this._settings.get_string('login-setup');
        const current = options.some(o => o.value === stored) ? stored : LOGIN_NONE;

        for (const r of this._loginOptionRows)
            this._loginRow.remove(r);
        this._loginOptionRows = [];

        let group = null;
        for (const option of options) {
            const check = new Gtk.CheckButton({
                active: option.value === current,
                valign: Gtk.Align.CENTER,
            });
            if (group)
                check.group = group;
            else
                group = check;
            const row = new Adw.ActionRow({
                title: option.title,
                subtitle: option.subtitle ?? '',
                activatable_widget: check,
                use_markup: false,
            });
            row.add_prefix(check);
            check.connect('toggled', () => {
                if (!check.active)
                    return;
                this._settings.set_string('login-setup', option.value);
                this._loginRow.subtitle = option.title;
            });
            this._loginRow.add_row(row);
            this._loginOptionRows.push(row);
            if (option.value === current)
                this._loginRow.subtitle = option.title;
        }
    }
}
