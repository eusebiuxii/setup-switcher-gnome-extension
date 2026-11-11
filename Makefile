UUID = setup-switcher@local
SOURCES = extension.js prefs.js metadata.json stylesheet.css
EXTRA = lib
DIST = dist/$(UUID).shell-extension.zip

.PHONY: all schemas pack install uninstall enable disable prefs log nested clean

all: pack

schemas:
	glib-compile-schemas --strict schemas/

pack: schemas
	mkdir -p dist
	gnome-extensions pack --force --out-dir=dist \
		--extra-source=lib --extra-source=stylesheet.css \
		--schema=schemas/org.gnome.shell.extensions.setup-switcher.gschema.xml .

# Installs for the current user. On Wayland, log out and back in afterwards
# the first time so GNOME Shell picks the extension up.
install: pack
	gnome-extensions install --force $(DIST)
	@echo "Installed. Log out and back in, then run: make enable"

uninstall:
	gnome-extensions uninstall $(UUID)

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

prefs:
	gnome-extensions prefs $(UUID)

# Follow the extension's log output.
log:
	journalctl -f -o cat /usr/bin/gnome-shell

# Test in a nested GNOME Shell window without logging out (GNOME 49+).
nested: install
	dbus-run-session -- gnome-shell --devkit --wayland

clean:
	rm -rf dist schemas/gschemas.compiled
