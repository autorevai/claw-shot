// Claude Shot: capture a macOS screenshot straight into Claude Code's terminal prompt.
//
// How it works: the macOS `screencapture` CLI (the same engine behind Cmd+Shift+3/4/5)
// writes a PNG to a temp file, then we insert that file path into the active terminal via
// `terminal.sendText(path, /* addNewLine */ false)`. Claude Code's TUI treats a pasted/typed
// image path exactly like a drag-and-dropped image and attaches it as `[Image #N]`.
//
// sendText is fully deterministic (unlike auto-pasting raw clipboard image bytes, which VS Code's
// paste command cannot do), so this is the reliable path to "give Claude vision" in one keystroke.

const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** @type {vscode.OutputChannel} */
let output;

function log(msg) {
  if (output) output.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function resolveSaveDir() {
  const cfg = vscode.workspace.getConfiguration('claudeShot');
  const configured = expandHome((cfg.get('saveDirectory') || '').trim());
  const dir = configured || path.join(os.tmpdir(), 'claude-shot');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    log(`mkdir failed for ${dir}: ${e.message}`);
  }
  return dir;
}

// Prune screenshots older than 24h unless the user opted to keep them.
function pruneOldFiles() {
  const cfg = vscode.workspace.getConfiguration('claudeShot');
  if (cfg.get('keepFiles')) return;
  const dir = resolveSaveDir();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^claude-shot-.*\.png$/.test(name)) continue;
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {}
    }
  } catch {}
}

// Pick the terminal to receive the path: a named match if configured, else the active terminal.
function pickTerminal() {
  const cfg = vscode.workspace.getConfiguration('claudeShot');
  const want = (cfg.get('targetTerminalName') || '').trim().toLowerCase();
  if (want) {
    const match = vscode.window.terminals.find((t) =>
      (t.name || '').toLowerCase().includes(want)
    );
    if (match) return match;
  }
  return vscode.window.activeTerminal || vscode.window.terminals[0] || null;
}

/**
 * @param {'region'|'fullscreen'|'window'} mode
 */
function capture(mode) {
  const cfg = vscode.workspace.getConfiguration('claudeShot');
  const dir = resolveSaveDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `claude-shot-${stamp}.png`);

  // screencapture flags:
  //   -i interactive (region or, with -w, window)   -w window mode
  //   -x no shutter sound                            -o omit window shadow (window mode)
  const args = [];
  if (!cfg.get('playSound')) args.push('-x');
  if (mode === 'region') args.push('-i');
  else if (mode === 'window') args.push('-i', '-w', '-o');
  // fullscreen = no -i flag
  args.push(file);

  log(`screencapture ${args.join(' ')}`);

  cp.execFile('/usr/sbin/screencapture', args, (err) => {
    if (err) {
      log(`screencapture error: ${err.message}`);
      vscode.window.showErrorMessage(`Claude Shot: capture failed. ${err.message}`);
      return;
    }
    // Interactive capture cancelled with Esc → no file (or zero bytes) is written.
    let ok = false;
    try {
      ok = fs.existsSync(file) && fs.statSync(file).size > 0;
    } catch {}
    if (!ok) {
      log('capture cancelled (no file written)');
      return;
    }

    const term = pickTerminal();
    if (!term) {
      vscode.window
        .showWarningMessage(
          `Claude Shot: no terminal found. Screenshot saved to ${file}`,
          'Copy Path'
        )
        .then((choice) => {
          if (choice === 'Copy Path') vscode.env.clipboard.writeText(file);
        });
      return;
    }

    // Insert the path with a trailing space, NO newline, so multiple captures accumulate
    // on the same prompt line. This mirrors a drag-and-drop; Claude Code attaches it as an image.
    term.sendText(file + ' ', false);
    if (cfg.get('focusTerminalAfterCapture')) {
      term.show(false); // reveal + focus so you can type your prompt right away
    }
    log(`sent path to terminal "${term.name}": ${file}`);
  });
}

function activate(context) {
  output = vscode.window.createOutputChannel('Claude Shot');
  context.subscriptions.push(output);

  pruneOldFiles();

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.text = '$(device-camera) Shot';
  statusBar.tooltip = 'Capture a region screenshot into Claude Code (Cmd+Alt+4)';
  statusBar.command = 'claudeShot.capture';
  statusBar.show();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeShot.capture', () => capture('region')),
    vscode.commands.registerCommand('claudeShot.captureFullscreen', () => capture('fullscreen')),
    vscode.commands.registerCommand('claudeShot.captureWindow', () => capture('window'))
  );

  log('Claude Shot activated');
}

function deactivate() {}

module.exports = { activate, deactivate };
