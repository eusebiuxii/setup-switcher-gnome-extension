# Setup Switcher

A GNOME Shell extension (GNOME 47–51) for switching between saved display setups
from Quick Settings: desk monitors, TV, both, couch gaming, and so on.

Each **setup** stores:

- **Screens:** which screens are on, resolution, refresh rate (including VRR),
  scale, rotation, position, primary screen and color mode (HDR).
- **Audio output:** where sound goes (e.g. the TV over HDMI or your desk speakers).
- **Commands (optional):** one runs when you switch *to* the setup, one when you
  switch *away* from it.

## Install

```sh
make install          # packs and installs for the current user
# log out and back in (Wayland needs this the first time)
make enable
```

Requires `pactl` for audio switching (Fedora: `pulseaudio-utils`; installed by
default on most PipeWire desktops).

## Usage

1. Arrange your screens in **Settings → Displays** for the first setup (e.g. desk).
2. Open the extension settings (`make prefs` or the **Setup Switcher Settings**
   item in the menu). Under **Setups → Save Current Layout**, enter a name, pick
   the audio output and optionally add commands, then click **Save Setup**.
3. Repeat for each setup (TV, both, ...).
4. Click the **Display Setup** tile in Quick Settings and pick a setup.

### Steam Big Picture example

| Setup  | Command when switching to       | Command when switching away      |
|--------|---------------------------------|----------------------------------|
| Couch  | `steam steam://open/bigpicture` | `steam steam://close/bigpicture` |

Commands run with `/bin/sh -c`, so you can chain them (`cmd1; cmd2`) or call a script.

### How switching works

1. The screen layout is applied.
2. If **Ask to keep changes** is on (default), GNOME shows *"Keep these display
   settings?"*. If you revert, or don't answer within 20 seconds, the screens go
   back and nothing else happens.
3. Once the change is kept, these run in order: the previous setup's
   "switching away" command, the audio switch, and the new setup's
   "switching to" command.

Setups whose screens aren't connected (e.g. the TV is unplugged) are greyed out
in the menu, or hidden if you turn on **Hide unavailable setups**.

Screens are matched by their EDID identity (make, model, serial), so a setup
keeps working if you move a cable to another port. The connector name is only
used to tell apart identical monitors.

### Audio notes

HDMI/DisplayPort audio outputs often only appear once the screen is on. The
extension retries for a few seconds, and if the output still isn't there it
switches the sound card to the profile that was active when you saved the setup.

### At login

**Behavior → Setup at login** can be:

- **Don't change:** GNOME restores its own last configuration.
- **Remember last used setup:** re-applies the setup you were on when you logged
  out or shut down.
- **A specific setup.**

Extensions start when you log in, not at boot, so the login screen itself uses
GNOME's normal configuration.

## Development

```sh
make pack       # build dist/setup-switcher@local.shell-extension.zip
make log        # follow GNOME Shell logs (messages are prefixed [setup-switcher])
make nested     # try it in a nested GNOME Shell window (GNOME 49+)
```

Files:

- `extension.js`: Quick Settings tile, switching logic, login handling
- `prefs.js`: settings window (Setups / Behavior pages)
- `lib/displayConfig.js`: Mutter `org.gnome.Mutter.DisplayConfig` D-Bus wrapper
- `lib/audio.js`: audio output switching via `pactl`
- `lib/setups.js`: storage helpers (setups are stored as JSON in GSettings)
