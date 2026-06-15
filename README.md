# Claude Shot

One keystroke: capture a macOS screenshot straight into Claude Code's terminal prompt. No drag-drop, no Preview, no clipboard juggling.

Built because dragging screenshots into Claude Code one file at a time is a caveman move.

## What it does

Press a shortcut → take a screenshot (region / full screen / window) → the file path is inserted into your active terminal where Claude Code is running. Claude Code treats a typed image path exactly like a dropped image and attaches it as `[Image #N]`.

Fire it four times → four images stack on the same prompt line → type your question → Enter. That's it.

| Shortcut | Action | Mirrors |
|----------|--------|---------|
| `Cmd+Alt+4` | Capture a region (click-drag) | macOS `Cmd+Shift+4` |
| `Cmd+Alt+3` | Capture full screen | macOS `Cmd+Shift+3` |
| `Cmd+Alt+5` | Capture a window | macOS `Cmd+Shift+4` then Space |

There's also a `$(device-camera) Shot` button in the status bar (region capture).

## Why file-path instead of clipboard

`terminal.sendText(path)` is 100% deterministic. Auto-pasting raw clipboard *image* data into the terminal TUI is not something a VS Code extension can do reliably (the paste command sends text, not image bytes). Inserting the saved file path mirrors a drag-and-drop, which Claude Code natively turns into an image attachment.

> Heads up: the path is sent without a trailing newline so captures accumulate. **You** press Enter when you've added all the shots and typed your prompt.

## Install

```bash
npm run package           # produces claude-shot-<version>.vsix
code --install-extension claude-shot-*.vsix
```

Then reload VS Code (`Cmd+Shift+P` → "Reload Window").

## macOS permission

The first capture may prompt for **Screen Recording** permission for VS Code (System Settings → Privacy & Security → Screen Recording). Grant it and restart VS Code. Region/window selection generally works without it; full-screen capture of other apps needs it.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeShot.saveDirectory` | `""` (OS temp) | Where PNGs are saved. Supports `~`. |
| `claudeShot.targetTerminalName` | `""` (active) | Only send to a terminal whose name contains this string. Set to `claude` if you keep a dedicated terminal. |
| `claudeShot.focusTerminalAfterCapture` | `true` | Reveal + focus the terminal after capture. |
| `claudeShot.keepFiles` | `false` | Keep PNGs. When false, files >24h old are pruned on startup. |
| `claudeShot.playSound` | `true` | Play the macOS shutter sound. |

## The zero-install alternative

You don't strictly need this extension. macOS `Cmd+Ctrl+Shift+4` captures a region straight to the clipboard, and Claude Code's terminal accepts **`Ctrl+V`** (control, not command) to paste a clipboard image as an attachment. This extension just compresses that into one keystroke, adds a status-bar button, and lets multiple shots accumulate.

## License

MIT
