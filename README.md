# GNOME Github PR Status Menu

A simple extension which fetches your PRs and shows them to you, categorized by status and with an indicator for passing/failed tests.

## Installation

```sh
glib-compile-schemas github-pr-status@danudey.github.com/schemas
mkdir -p ~/.local/share/gnome-shell/extensions/
ln -s "$(pwd)/github-pr-status@danudey.github.com" ~/.local/share/gnome-shell/extensions/
```

That's probably all you need? I'm not sure.

## Uninstallation

```sh
rm ~/.local/share/gnome-shell/extensions/github-pr-status@danudey.github.com
```

## Security

The extension needs a Github token to operate; the token is stored in the dbus secretserver, which on GNOME you can access by opening "Passwords and Keys". It should be saved in your default keychain under the name 'GitHub PR Status Token'.

Nothing is sent from your system, nothing is cached on-disk, no tokens or credentials are saved, so there should be no risk of information leakage. If you find otherwise, please let me know or submit a PR.

## AI Policy

This entire thing was written by Claude Code using Opus 4.6 so obviously I'm not going to say "No AI", but low-effort drive-by PRs may be closed without comment.