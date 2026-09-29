# Claude Usage

A GNOME Shell 51 extension that adds a panel icon. Click it to see how much of
each Claude usage limit is left and when it resets. The menu also shows the
status from [status.claude.com](https://status.claude.com) and any unresolved
incidents. Click the status to open the status page.

It reuses the sign-in that [Claude Code](https://claude.com/claude-code) stores
in `~/.claude/.credentials.json`, so you need to be signed in to Claude Code.

When that sign-in expires, the extension runs `claude doctor` in the
background, which renews it the same way Claude Code does during normal use.
It tries this at most once every 5 minutes. The extension never exchanges
tokens itself, because a renewal can replace the refresh token that Claude Code
relies on. If `claude doctor` can't renew the sign-in, run `claude`.
The extension notices new sign-ins straight away.

## Install

```sh
make install
```

Log out and back in (Wayland can't reload the shell in place), then run:

```sh
gnome-extensions enable claude-usage@gurney.dev
```

## Test

```sh
make test
```

## Lint

```sh
bun install
bun run lint
bun run format
```
