# Genshin Chrome

A programmable Electron browser shell for macOS. Other operating systems are not supported.

## Development

```bash
bun install
bun run dev
```

## Configuration

The app creates its ESM configuration on first launch:

```text
~/.config/genshin-chrome/config.js
```

Set `XDG_CONFIG_HOME` to change the configuration root. Use the toolbar button to open `config.js` in the default editor, then restart the app after editing.

Edit the generated object directly. Its synchronous `rewrite` hook may return `null`, `{ url }`, or `{ cancel: true }`. The configuration is fully trusted and errors fail when encountered.

Only `startUrl` is required. The `session`, `window`, `browser`, and `requests` groups—and every field inside them—are optional and merge with the generated defaults.

Window width and height are remembered automatically in the app's user-data directory and aren't part of `config.js`. The only window option is `window.backgroundColor`.

## Install

Build and install `Genshin Chrome.app` into `~/Applications`:

```bash
./install.ts
```

Use `./install.ts --npmmirror` when Electron downloads are slow. Run `./install.ts --help` for all options.

## Checks

```bash
bun run check
```
