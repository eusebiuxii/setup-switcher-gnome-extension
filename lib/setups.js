// Storage helpers for saved setups. Shared by the extension and prefs.
//
// A setup looks like:
// {
//   id: string,
//   name: string,
//   layout: { layoutMode, logicalMonitors: [...] },   // see displayConfig.js
//   audio: null | { sinkName, description, port, cardName, cardProfile },
//   onEnter: string,   // shell command run when switching to this setup
//   onLeave: string,   // shell command run when switching away from it
// }

import GLib from 'gi://GLib';

export const LOGIN_NONE = '';
export const LOGIN_LAST = '__last__';

export function loadSetups(settings) {
    try {
        const setups = JSON.parse(settings.get_string('setups'));
        return Array.isArray(setups) ? setups : [];
    } catch (e) {
        console.error(`[setup-switcher] Could not parse saved setups: ${e}`);
        return [];
    }
}

export function saveSetups(settings, setups) {
    settings.set_string('setups', JSON.stringify(setups));
}

export function newSetupId() {
    return GLib.uuid_string_random();
}
