# Claw Shot

Screenshots straight into Claude Code. Take a screenshot from any app and it lands in your Claude Code terminal automatically. No drag-drop, no Preview, no Finder.

Built because feeding screenshots to Claude Code one drag at a time is a caveman move.

## The main way: watch mode (works from any app)

Watch mode is on by default. With VS Code open (it can be in the background, you don't have to focus it):

1. Take a screenshot from **anywhere** with the native macOS shortcut: `Cmd+Shift+4` (region) or `Cmd+Shift+3` (full screen). These are global and work in Chrome, Figma, anywhere.
2. Claw Shot sees the new screenshot and injects its path into your Claude Code terminal.
3. Type your question, hit Enter. Claude reads the image.

That's it. The native screenshot shortcuts you already use just start flowing into Claude Code.

Toggle watch mode with **`Cmd+Option+0`** or the status-bar button (`$(eye)` = watching, `$(camera)` = off).

> **VS Code must be running** (background is fine) because your Claude terminal lives inside it. If it's quit, there's no terminal to receive the shot.

## The other way: in-app capture shortcuts

When VS Code *is* focused, you can capture without leaving it:

| Shortcut | Action |
|----------|--------|
| `Cmd+Option+4` | Region |
| `Cmd+Option+3` | Full screen |
| `Cmd+Option+5` | Window |
| `Cmd+Option+0` | Toggle watch mode |

(These use `Option` instead of `Shift` so they don't collide with the native macOS screenshots. They only fire while VS Code is the focused app, which is why watch mode exists for everything else.)

## Targeting the right terminal

By default the path goes to your active (last-focused) terminal. With many terminals open, pin it:

1. Right-click your Claude terminal tab → **Rename** → call it `claude`
2. Set `clawShot.targetTerminalName` to `claude`

Now every shot routes there regardless of focus.

## Install

```bash
npm run package           # produces claw-shot-<version>.vsix
code --install-extension claw-shot-*.vsix
```

Reload VS Code (`Cmd+Shift+P` → "Reload Window"). Grant **Screen Recording** permission to VS Code on first in-app capture (System Settings → Privacy & Security → Screen Recording). Watch mode doesn't need that permission, since macOS itself takes the screenshot.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `clawShot.watchOnStartup` | `true` | Auto-inject screenshots from the macOS screenshot folder on startup. |
| `clawShot.screenshotDirectory` | `""` (auto) | Folder to watch. Empty = auto-detect the macOS screenshot location. Supports `~`. |
| `clawShot.targetTerminalName` | `""` (active) | Only send to a terminal whose name contains this string. |
| `clawShot.saveDirectory` | `""` (temp) | Where in-app `Cmd+Option` captures are saved. |
| `clawShot.focusTerminalAfterCapture` | `true` | Focus the terminal after an in-app capture. |
| `clawShot.keepFiles` | `false` | Keep in-app capture files (>24h old are pruned otherwise). Never touches your native screenshots. |
| `clawShot.playSound` | `true` | Shutter sound on in-app captures. |

## Privacy & security

Claw Shot is built to send nothing anywhere:

- **No network calls, no telemetry, no analytics.** Nothing phones home. The code makes zero HTTP requests.
- **No dependencies.** Pure VS Code API + Node stdlib. ~200 lines, auditable in minutes.
- **Local-only actions:** runs `screencapture`, reads your macOS screenshot folder location (`defaults read`, read-only), watches that folder, and types the screenshot's file path into your terminal. It never deletes or uploads your screenshots, and only prunes its *own* temp captures (older than 24h).

**One thing to know about the workflow:** when you submit a screenshot to Claude Code, the image is uploaded to Anthropic so Claude can see it (this is true of any screenshot you give Claude, including drag-drop). Watch mode only *inserts the file path* into your prompt; it does not submit. **You press Enter.** So if a screenshot with a password, API key, or customer data lands in your prompt, delete the path before submitting. Turn watch mode off (`Cmd+Option+0`) when you're capturing sensitive screens for other purposes.

## How it works

Claw Shot inserts the screenshot's **file path** into the terminal via `terminal.sendText`. Claude Code reads that path as an image. This is deterministic, unlike auto-pasting raw clipboard image bytes (which a VS Code extension can't reliably do). Watch mode uses `fs.watch` on the macOS screenshot folder; in-app capture shells out to `screencapture`.

## License

MIT
