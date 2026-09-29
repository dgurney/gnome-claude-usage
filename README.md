# Claude Usage

A GNOME Shell 51 extension that shows how much of your Claude session and
weekly usage limits is left in the top bar. Click it to see every limit and
when each one resets. The menu also shows the status from
[status.claude.com](https://status.claude.com) and any unresolved incidents.
Click the status to open the status page.

The usage and status refresh every 5 minutes, and when you open the menu if
they're more than a minute old.

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
