UUID = claude-usage@gurney.dev
ZIP = $(UUID).shell-extension.zip

.PHONY: pack install test clean

pack:
	gnome-extensions pack --force --extra-source=usage.js --extra-source=format.js --extra-source=status.js .

install: pack
	gnome-extensions install --force $(ZIP)

test:
	TZ=UTC LC_ALL=C gjs -m tests/test.js

clean:
	rm -f $(ZIP)
