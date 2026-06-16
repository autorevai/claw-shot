// Claw Shot: capture a macOS screenshot straight into Claude Code's terminal prompt.
//
// Two ways to feed a screenshot into the active terminal:
//
// 1. In-app shortcuts (Cmd+Option+3/4/5): run macOS `screencapture` to a temp PNG, then insert the
//    path via `terminal.sendText`. These only fire while VS Code is the focused app (a hard limit of
//    VS Code keybindings).
//
// 2. Watch mode: watch the macOS screenshot save folder (where native Cmd+Shift+3/4 land). Any new
//    screenshot, taken from ANY app, gets its path auto-injected into the target terminal. This is the
//    only way to capture other apps (Chrome, etc.), because native screenshot shortcuts are global.
//
// Either way Claude Code reads the inserted path as an image, so you get vision with no drag-drop.

const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** @type {vscode.OutputChannel} */
let output;
/** @type {vscode.StatusBarItem} */
let statusBar;
/** @type {fs.FSWatcher | null} */
let watcher = null;
let watchEnabled = false;
let watchDir = '';
const injected = new Set(); // de-dupe filenames (fs.watch can fire twice per file)

// Multi-window coordination: every VS Code window runs its own extension host (with a unique
// process.pid). Without this, each open window would inject the same screenshot. Each watching
// window writes a heartbeat + last-focused timestamp to a shared temp dir, and only the
// most-recently-focused live window injects a given screenshot.
const WIN_ID = String(process.pid);
const COORD_DIR = path.join(os.tmpdir(), 'claw-shot', 'windows');
const WINDOW_TTL_MS = 15000; // a window file not refreshed within this window is treated as dead
let heartbeatTimer = null;
let focusDisposable = null;

function log(msg) {
  if (output) output.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function cfg() {
  return vscode.workspace.getConfiguration('clawShot');
}

function resolveSaveDir() {
  const configured = expandHome((cfg().get('saveDirectory') || '').trim());
  const dir = configured || path.join(os.tmpdir(), 'claw-shot');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    log(`mkdir failed for ${dir}: ${e.message}`);
  }
  return dir;
}

// Prune Claw Shot's own temp screenshots older than 24h unless the user opted to keep them.
function pruneOldFiles() {
  if (cfg().get('keepFiles')) return;
  const dir = resolveSaveDir();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^claw-shot-.*\.png$/.test(name)) continue;
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {}
    }
  } catch {}
}

// Pick the terminal to receive the path: a named match if configured, else the active terminal.
function pickTerminal() {
  const want = (cfg().get('targetTerminalName') || '').trim().toLowerCase();
  if (want) {
    const match = vscode.window.terminals.find((t) =>
      (t.name || '').toLowerCase().includes(want)
    );
    if (match) return match;
  }
  return vscode.window.activeTerminal || vscode.window.terminals[0] || null;
}

// Insert a file path into the target terminal (trailing space, no newline) so multiple shots
// accumulate on one prompt line. Returns true if a terminal received it.
function injectPath(file, { focus }) {
  const term = pickTerminal();
  if (!term) {
    vscode.window
      .showWarningMessage(`Claw Shot: no terminal found. Screenshot saved to ${file}`, 'Copy Path')
      .then((choice) => {
        if (choice === 'Copy Path') vscode.env.clipboard.writeText(file);
      });
    return false;
  }
  term.sendText(file + ' ', false);
  if (focus) term.show(false);
  log(`injected into terminal "${term.name}": ${file}`);
  return true;
}

/**
 * In-app capture via screencapture.
 * @param {'region'|'fullscreen'|'window'} mode
 */
function capture(mode) {
  const dir = resolveSaveDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `claw-shot-${stamp}.png`);

  // screencapture flags: -i interactive, -w window mode, -x no sound, -o no window shadow.
  const args = [];
  if (!cfg().get('playSound')) args.push('-x');
  const interactive = mode === 'region' || mode === 'window';
  if (mode === 'region') args.push('-i');
  else if (mode === 'window') args.push('-i', '-w', '-o');
  args.push(file);

  log(`screencapture ${args.join(' ')}`);

  cp.execFile('/usr/sbin/screencapture', args, (err) => {
    if (err) {
      log(`screencapture error: ${err.message}`);
      vscode.window.showErrorMessage(`Claw Shot: capture failed. ${err.message}`);
      return;
    }
    let ok = false;
    try {
      ok = fs.existsSync(file) && fs.statSync(file).size > 0;
    } catch {}
    if (!ok) {
      // Fullscreen capture has nothing to cancel, so a missing file means a permission problem.
      if (!interactive) {
        log('fullscreen capture produced no file (likely missing Screen Recording permission)');
        vscode.window
          .showWarningMessage(
            'Claw Shot: capture produced no image. Grant Screen Recording permission to VS Code, then reload.',
            'Open Settings'
          )
          .then((choice) => {
            if (choice === 'Open Settings') {
              cp.exec(
                'open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"'
              );
            }
          });
      } else {
        log('interactive capture cancelled (no file written)');
      }
      return;
    }
    injectPath(file, { focus: cfg().get('focusTerminalAfterCapture') });
  });
}

// ---- Watch mode: auto-inject screenshots taken anywhere on the system ----

// macOS stores the screenshot folder + filename prefix in defaults; fall back to ~/Desktop / "Screenshot".
function macScreenshotConfig() {
  let dir = path.join(os.homedir(), 'Desktop');
  let prefix = 'Screenshot';
  try {
    const loc = cp.execSync('defaults read com.apple.screencapture location 2>/dev/null').toString().trim();
    if (loc) dir = expandHome(loc);
  } catch {}
  try {
    const name = cp.execSync('defaults read com.apple.screencapture name 2>/dev/null').toString().trim();
    if (name) prefix = name;
  } catch {}
  return { dir, prefix };
}

// ---- Multi-window leader election ----

// Record this window's liveness (file mtime) and last-focused time in the shared coordination dir.
function writeWindowState() {
  try {
    fs.mkdirSync(COORD_DIR, { recursive: true });
    const f = path.join(COORD_DIR, `${WIN_ID}.json`);
    let focusedAt = 0;
    try {
      focusedAt = JSON.parse(fs.readFileSync(f, 'utf8')).focusedAt || 0;
    } catch {}
    // A currently-focused window stamps "now" so it stays the leader.
    if (vscode.window.state && vscode.window.state.focused) focusedAt = Date.now();
    fs.writeFileSync(f, JSON.stringify({ pid: Number(WIN_ID), focusedAt }));
  } catch (e) {
    log(`writeWindowState failed: ${e.message}`);
  }
}

function removeWindowState() {
  try {
    fs.unlinkSync(path.join(COORD_DIR, `${WIN_ID}.json`));
  } catch {}
}

// True if this window is the most-recently-focused live window running watch mode.
// Deterministic tie-break by pid so every window independently agrees on a single leader.
function isLeaderWindow() {
  try {
    const now = Date.now();
    let bestPid = -1;
    let bestFocus = -1;
    for (const name of fs.readdirSync(COORD_DIR)) {
      if (!name.endsWith('.json')) continue;
      const full = path.join(COORD_DIR, name);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (now - st.mtimeMs > WINDOW_TTL_MS) continue; // stale = window closed/crashed
      let data;
      try {
        data = JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch {
        continue;
      }
      const pid = Number(data.pid);
      const fa = Number(data.focusedAt) || 0;
      if (fa > bestFocus || (fa === bestFocus && pid > bestPid)) {
        bestFocus = fa;
        bestPid = pid;
      }
    }
    return bestPid === -1 || bestPid === Number(WIN_ID);
  } catch {
    return true; // coordination unavailable -> assume single window, inject
  }
}

function startWatch() {
  if (watcher) return;
  const override = expandHome((cfg().get('screenshotDirectory') || '').trim());
  let prefix = 'Screenshot';
  if (override) {
    watchDir = override;
  } else {
    const mac = macScreenshotConfig();
    watchDir = mac.dir;
    prefix = mac.prefix;
  }
  const imageRe = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*\\.(png|jpg|jpeg)$`, 'i');
  try {
    watcher = fs.watch(watchDir, (event, filename) => {
      if (!filename || event !== 'rename') return;
      if (!imageRe.test(filename)) return;
      if (injected.has(filename)) return;
      const full = path.join(watchDir, filename);
      // Wait for the OS to finish writing the file before injecting.
      setTimeout(() => {
        let ready = false;
        try {
          ready = fs.existsSync(full) && fs.statSync(full).size > 0;
        } catch {}
        if (!ready) return;
        injected.add(filename);
        if (!isLeaderWindow()) {
          log(`watch detected ${filename}; another window is the active target, skipping`);
          return;
        }
        log(`watch detected: ${full}`);
        injectPath(full, { focus: false });
      }, 350);
    });
    watchEnabled = true;
    // Start multi-window coordination: heartbeat + focus tracking so only one window injects.
    writeWindowState();
    focusDisposable = vscode.window.onDidChangeWindowState(() => writeWindowState());
    heartbeatTimer = setInterval(writeWindowState, 5000);
    if (heartbeatTimer.unref) heartbeatTimer.unref();
    log(`watching screenshot folder: ${watchDir} (prefix "${prefix}")`);
  } catch (e) {
    watchEnabled = false;
    log(`failed to watch ${watchDir}: ${e.message}`);
    vscode.window.showErrorMessage(`Claw Shot: could not watch ${watchDir}. ${e.message}`);
  }
}

function stopWatch() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (focusDisposable) {
    focusDisposable.dispose();
    focusDisposable = null;
  }
  removeWindowState();
  watchEnabled = false;
  injected.clear();
  log('watch stopped');
}

function updateStatusBar() {
  if (!statusBar) return;
  statusBar.text = watchEnabled ? '$(eye) Shot' : '$(device-camera) Shot';
  statusBar.tooltip = watchEnabled
    ? `Claw Shot: watching ${watchDir} (native Cmd+Shift+3/4 auto-inject). Click for menu.`
    : 'Claw Shot: click for capture menu';
}

function toggleWatch() {
  if (watchEnabled) stopWatch();
  else startWatch();
  updateStatusBar();
  vscode.window.setStatusBarMessage(
    watchEnabled ? `Claw Shot: watching ${watchDir}` : 'Claw Shot: watch off',
    3000
  );
}

// Status-bar button -> quick pick of capture modes + watch toggle.
async function showMenu() {
  const pick = await vscode.window.showQuickPick(
    [
      { label: '$(screen-full) Full screen', action: 'fullscreen', description: 'Cmd+Option+3' },
      { label: '$(selection) Region', action: 'region', description: 'Cmd+Option+4' },
      { label: '$(window) Window', action: 'window', description: 'Cmd+Option+5' },
      {
        label: watchEnabled ? '$(eye-closed) Turn OFF watch mode' : '$(eye) Turn ON watch mode',
        action: 'toggle',
        description: watchEnabled
          ? 'stop auto-injecting screenshots'
          : 'auto-inject native Cmd+Shift+3/4 from any app',
      },
    ],
    { placeHolder: 'Claw Shot: capture into Claude Code' }
  );
  if (!pick) return;
  if (pick.action === 'toggle') toggleWatch();
  else capture(pick.action);
}

function activate(context) {
  output = vscode.window.createOutputChannel('Claw Shot');
  context.subscriptions.push(output);

  pruneOldFiles();

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'clawShot.menu';
  statusBar.show();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('clawShot.menu', showMenu),
    vscode.commands.registerCommand('clawShot.capture', () => capture('region')),
    vscode.commands.registerCommand('clawShot.captureFullscreen', () => capture('fullscreen')),
    vscode.commands.registerCommand('clawShot.captureWindow', () => capture('window')),
    vscode.commands.registerCommand('clawShot.toggleWatch', toggleWatch),
    { dispose: stopWatch }
  );

  if (cfg().get('watchOnStartup')) startWatch();
  updateStatusBar();

  log('Claw Shot activated');
}

function deactivate() {
  stopWatch();
}

module.exports = { activate, deactivate };
