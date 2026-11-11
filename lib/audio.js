// Audio output handling through `pactl` (works with PipeWire via
// pipewire-pulse and with PulseAudio). Shared by the extension and prefs.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export function run(argv) {
    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            reject(e);
            return;
        }
        proc.communicate_utf8_async(null, null, (p, res) => {
            try {
                const [, stdout, stderr] = p.communicate_utf8_finish(res);
                if (p.get_successful())
                    resolve(stdout ?? '');
                else
                    reject(new Error(`${argv.join(' ')}: ${(stderr ?? '').trim() || 'failed'}`));
            } catch (e) {
                reject(e);
            }
        });
    });
}

function delay(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

export function isAvailable() {
    return GLib.find_program_in_path('pactl') !== null;
}

/**
 * Lists audio outputs.
 * @returns {Promise<{name, description, port, cardName, cardProfile}[]>}
 */
export async function listSinks() {
    const [sinksJson, cardsJson] = await Promise.all([
        run(['pactl', '-f', 'json', 'list', 'sinks']),
        run(['pactl', '-f', 'json', 'list', 'cards']).catch(() => '[]'),
    ]);
    const cards = new Map(JSON.parse(cardsJson).map(c => [c.name, c]));
    return JSON.parse(sinksJson).map(s => {
        const cardName = s.properties?.['device.name'] ?? null;
        return {
            name: s.name,
            description: s.description || s.name,
            port: s.active_port ?? null,
            cardName,
            cardProfile: cards.get(cardName)?.active_profile ?? null,
        };
    });
}

export async function getDefaultSink() {
    try {
        return (await run(['pactl', 'get-default-sink'])).trim();
    } catch {
        return '';
    }
}

/** Builds the object stored in a setup from a listed sink. */
export function audioFromSink(sink) {
    if (!sink)
        return null;
    return {
        sinkName: sink.name,
        description: sink.description,
        port: sink.port,
        cardName: sink.cardName,
        cardProfile: sink.cardProfile,
    };
}

/**
 * Makes the saved output the default one. HDMI/DisplayPort outputs often only
 * show up after the screen turns on, or only after the sound card is switched
 * to the right profile, so this retries for a few seconds.
 */
export async function applyAudio(audio, {attempts = 16, interval = 500} = {}) {
    if (!audio?.sinkName)
        return;

    let profileSet = false;
    for (let i = 0; i < attempts; i++) {
        let sinks = [];
        try {
            sinks = await listSinks();
        } catch (e) {
            console.warn(`[setup-switcher] ${e.message}`);
        }
        const sink = sinks.find(s => s.name === audio.sinkName);
        if (sink) {
            if (audio.port && sink.port !== audio.port)
                await run(['pactl', 'set-sink-port', sink.name, audio.port]).catch(e => console.warn(e.message));
            await run(['pactl', 'set-default-sink', sink.name]);
            return;
        }

        // Output not there yet: try switching the card profile once, after
        // giving the HDMI audio device a moment to appear on its own.
        if (!profileSet && i >= 2 && audio.cardName && audio.cardProfile) {
            profileSet = true;
            await run(['pactl', 'set-card-profile', audio.cardName, audio.cardProfile])
                .catch(e => console.warn(`[setup-switcher] ${e.message}`));
        }
        await delay(interval);
    }
    throw new Error(`Audio output "${audio.description ?? audio.sinkName}" was not found`);
}
