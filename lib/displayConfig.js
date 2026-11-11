// Talks to Mutter's org.gnome.Mutter.DisplayConfig D-Bus API to read the
// current monitor layout, capture it into a serialisable "layout" object and
// apply a saved layout again. Shared by the extension and prefs (Gio only).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BUS_NAME = 'org.gnome.Mutter.DisplayConfig';
const OBJECT_PATH = '/org/gnome/Mutter/DisplayConfig';
const IFACE = 'org.gnome.Mutter.DisplayConfig';

const STATE_TYPE = '(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})';
const APPLY_TYPE = '(uua(iiduba(ssa{sv}))a{sv})';

export const ApplyMethod = Object.freeze({VERIFY: 0, TEMPORARY: 1, PERSISTENT: 2});
export const LayoutMode = Object.freeze({LOGICAL: 1, PHYSICAL: 2});

const TRANSFORM_NAMES = ['', '90°', '180°', '270°', 'flipped', 'flipped 90°', 'flipped 180°', 'flipped 270°'];

function dbusCall(method, params, replyType = null) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(BUS_NAME, OBJECT_PATH, IFACE, method, params,
            replyType ? new GLib.VariantType(replyType) : null,
            Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                try {
                    resolve(conn.call_finish(res));
                } catch (e) {
                    if (e instanceof GLib.Error)
                        Gio.DBusError.strip_remote_error(e);
                    reject(e);
                }
            });
    });
}

/**
 * Calls `callback` whenever the monitor configuration changes.
 * @returns {Function} call it to unsubscribe
 */
export function watchMonitorsChanged(callback) {
    const id = Gio.DBus.session.signal_subscribe(BUS_NAME, IFACE,
        'MonitorsChanged', OBJECT_PATH, null, Gio.DBusSignalFlags.NONE,
        () => callback());
    return () => Gio.DBus.session.signal_unsubscribe(id);
}

/** Reads and normalises the current display state from Mutter. */
export async function getCurrentState() {
    const reply = await dbusCall('GetCurrentState', null, STATE_TYPE);
    const [serial, monitors, logicalMonitors, properties] = reply.recursiveUnpack();

    return {
        serial,
        layoutMode: properties['layout-mode'] ?? LayoutMode.LOGICAL,
        supportsChangingLayoutMode: !!properties['supports-changing-layout-mode'],
        monitors: monitors.map(([[connector, vendor, product, serialNo], modes, props]) => ({
            connector,
            vendor,
            product,
            serial: serialNo,
            displayName: props['display-name'] ?? connector,
            isBuiltin: !!props['is-builtin'],
            isForLease: !!props['is-for-lease'],
            colorMode: props['color-mode'] ?? null,
            supportedColorModes: props['supported-color-modes'] ?? [],
            rgbRange: props['rgb-range'] ?? null,
            isUnderscanning: props['is-underscanning'] ?? null,
            modes: modes.map(([id, width, height, refresh, preferredScale, supportedScales, mprops]) => ({
                id,
                width,
                height,
                refresh,
                preferredScale,
                supportedScales,
                isCurrent: !!mprops['is-current'],
                isPreferred: !!mprops['is-preferred'],
                refreshRateMode: mprops['refresh-rate-mode'] ?? 'fixed',
            })),
        })),
        logicalMonitors: logicalMonitors.map(([x, y, scale, transform, primary, specs]) => ({
            x, y, scale, transform, primary,
            connectors: specs.map(spec => spec[0]),
        })),
    };
}

/** Turns the current state into a layout object that can be stored as JSON. */
export function captureLayout(state) {
    return {
        layoutMode: state.layoutMode,
        logicalMonitors: state.logicalMonitors.map(lm => ({
            x: lm.x,
            y: lm.y,
            scale: lm.scale,
            transform: lm.transform,
            primary: lm.primary,
            monitors: lm.connectors.map(connector => {
                const m = state.monitors.find(mon => mon.connector === connector);
                const mode = m.modes.find(md => md.isCurrent) ?? null;
                return {
                    connector: m.connector,
                    vendor: m.vendor,
                    product: m.product,
                    serial: m.serial,
                    displayName: m.displayName,
                    mode: mode && {
                        id: mode.id,
                        width: mode.width,
                        height: mode.height,
                        refresh: mode.refresh,
                        refreshRateMode: mode.refreshRateMode,
                    },
                    colorMode: m.colorMode,
                    rgbRange: m.rgbRange,
                    underscanning: m.isUnderscanning,
                };
            }),
        })),
    };
}

/** All saved monitors of a layout, flattened. */
export function layoutMonitors(layout) {
    return layout.logicalMonitors.flatMap(lm => lm.monitors);
}

/**
 * Maps every monitor of a saved layout to a currently connected monitor.
 * Matching uses the EDID identity (vendor, product, serial) so a setup keeps
 * working if cables are moved to other ports; the connector name is only used
 * to tell identical monitors apart.
 */
function resolveMonitors(layout, state) {
    const saved = layoutMonitors(layout);
    const result = new Map();
    const taken = new Set();
    const candidatesFor = s => state.monitors.filter(m =>
        !m.isForLease && !taken.has(m.connector) &&
        m.vendor === s.vendor && m.product === s.product && m.serial === s.serial);

    // Pass 1: same monitor on the same port.
    for (const s of saved) {
        const m = candidatesFor(s).find(c => c.connector === s.connector);
        if (m) {
            result.set(s, m);
            taken.add(m.connector);
        }
    }
    // Pass 2: same monitor, different port.
    for (const s of saved) {
        if (result.has(s))
            continue;
        const m = candidatesFor(s)[0];
        if (m) {
            result.set(s, m);
            taken.add(m.connector);
        }
    }
    return result;
}

function findMode(savedMode, monitor) {
    if (!savedMode)
        return monitor.modes.find(m => m.isPreferred) ?? monitor.modes[0] ?? null;

    const exact = monitor.modes.find(m => m.id === savedMode.id);
    if (exact)
        return exact;

    const rateMode = savedMode.refreshRateMode ?? 'fixed';
    const similar = monitor.modes
        .filter(m => m.width === savedMode.width && m.height === savedMode.height &&
            m.refreshRateMode === rateMode)
        .sort((a, b) => Math.abs(a.refresh - savedMode.refresh) - Math.abs(b.refresh - savedMode.refresh));
    if (similar.length && Math.abs(similar[0].refresh - savedMode.refresh) < 1)
        return similar[0];
    return null;
}

function pickScale(scale, modes) {
    // Mutter only accepts scales that every monitor in the logical monitor supports.
    const supported = modes.reduce((acc, mode) =>
        acc.filter(s => mode.supportedScales.some(t => Math.abs(t - s) < 1e-4)),
    modes[0]?.supportedScales ?? [scale]);
    if (supported.length === 0)
        return scale;
    return supported.reduce((best, s) =>
        Math.abs(s - scale) < Math.abs(best - scale) ? s : best);
}

/**
 * Works out how to apply `layout` on the current hardware.
 * @returns {{logicalMonitors: object[], problems: string[]}}
 */
export function buildConfig(layout, state) {
    const problems = [];
    const resolved = resolveMonitors(layout, state);
    const logicalMonitors = [];

    for (const lm of layout.logicalMonitors) {
        const monitors = [];
        const modes = [];
        for (const s of lm.monitors) {
            const m = resolved.get(s);
            if (!m) {
                problems.push(`${s.displayName} is not connected`);
                continue;
            }
            const mode = findMode(s.mode, m);
            if (!mode) {
                problems.push(`${s.displayName}: ${s.mode.width}×${s.mode.height} @ ${formatRefresh(s.mode.refresh)} is not available`);
                continue;
            }
            const props = {};
            if (s.colorMode !== null && s.colorMode !== undefined && m.colorMode !== null &&
                m.supportedColorModes.includes(s.colorMode))
                props['color-mode'] = new GLib.Variant('u', s.colorMode);
            if (s.rgbRange !== null && s.rgbRange !== undefined && m.rgbRange !== null)
                props['rgb-range'] = new GLib.Variant('u', s.rgbRange);
            if (s.underscanning !== null && s.underscanning !== undefined && m.isUnderscanning !== null)
                props['underscanning'] = new GLib.Variant('b', s.underscanning);

            monitors.push({connector: m.connector, modeId: mode.id, props});
            modes.push(mode);
        }
        if (monitors.length === 0)
            continue;
        logicalMonitors.push({
            x: lm.x,
            y: lm.y,
            scale: pickScale(lm.scale, modes),
            transform: lm.transform,
            primary: lm.primary,
            monitors,
        });
    }

    if (logicalMonitors.length && !logicalMonitors.some(lm => lm.primary))
        logicalMonitors[0].primary = true;

    return {logicalMonitors, problems};
}

/** True if every monitor (and mode) of the layout is currently available. */
export function isLayoutAvailable(layout, state) {
    return buildConfig(layout, state).problems.length === 0;
}

/** True if the current display state already matches the layout. */
export function isLayoutActive(layout, state) {
    const {logicalMonitors, problems} = buildConfig(layout, state);
    if (problems.length)
        return false;
    if (state.supportsChangingLayoutMode && (layout.layoutMode ?? state.layoutMode) !== state.layoutMode)
        return false;
    if (logicalMonitors.length !== state.logicalMonitors.length)
        return false;

    return logicalMonitors.every(want => {
        const have = state.logicalMonitors.find(lm => lm.x === want.x && lm.y === want.y);
        if (!have ||
            Math.abs(have.scale - want.scale) > 1e-3 ||
            have.transform !== want.transform ||
            have.primary !== want.primary ||
            have.connectors.length !== want.monitors.length)
            return false;
        return want.monitors.every(wm => {
            if (!have.connectors.includes(wm.connector))
                return false;
            const mon = state.monitors.find(m => m.connector === wm.connector);
            return mon?.modes.find(md => md.isCurrent)?.id === wm.modeId;
        });
    });
}

/**
 * Applies a layout. With ApplyMethod.PERSISTENT GNOME Shell shows its
 * "Keep these display settings?" dialog and reverts on timeout.
 */
export async function applyLayout(layout, state, method) {
    const {logicalMonitors, problems} = buildConfig(layout, state);
    if (problems.length)
        throw new Error(problems.join('\n'));
    if (logicalMonitors.length === 0)
        throw new Error('The setup has no screens to turn on');

    const lms = logicalMonitors.map(lm => [
        lm.x, lm.y, lm.scale, lm.transform, lm.primary,
        lm.monitors.map(m => [m.connector, m.modeId, m.props]),
    ]);
    const props = {};
    if (state.supportsChangingLayoutMode && layout.layoutMode)
        props['layout-mode'] = new GLib.Variant('u', layout.layoutMode);

    await dbusCall('ApplyMonitorsConfig',
        new GLib.Variant(APPLY_TYPE, [state.serial, method, lms, props]));
}

export function formatRefresh(refresh) {
    const rounded = Math.round(refresh);
    return Math.abs(refresh - rounded) < 0.05 ? `${rounded} Hz` : `${refresh.toFixed(2)} Hz`;
}

/** Human readable one-line description of one saved monitor. */
export function describeMonitor(savedMonitor, logicalMonitor) {
    const parts = [];
    const mode = savedMonitor.mode;
    if (mode) {
        let res = `${mode.width}×${mode.height} @ ${formatRefresh(mode.refresh)}`;
        if (mode.refreshRateMode === 'variable')
            res += ' (VRR)';
        parts.push(res);
    }
    if (logicalMonitor) {
        if (Math.abs(logicalMonitor.scale - 1) > 1e-3)
            parts.push(`${Math.round(logicalMonitor.scale * 100)}%`);
        if (TRANSFORM_NAMES[logicalMonitor.transform])
            parts.push(TRANSFORM_NAMES[logicalMonitor.transform]);
        if (logicalMonitor.primary)
            parts.push('primary');
    }
    return parts.join(' · ');
}

/** Short summary of a layout, e.g. "DELL U2720Q, LG TV". */
export function summarizeLayout(layout) {
    const names = layoutMonitors(layout).map(m => m.displayName);
    if (names.length === 0)
        return 'No screens';
    return names.join(', ');
}
