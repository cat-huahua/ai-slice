'use strict';
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

const stl = require('../lib/stl');
const llm = require('../lib/llm');
const slicer = require('../lib/slicer');
const { makeStore } = require('../lib/store');

// Run through XWayland on Wayland sessions. Electron's native-Wayland backend has
// window/popup quirks on KDE (native <select> dropdowns could render behind other
// controls); XWayland renders them correctly. Harmless on X11 sessions.
if (process.platform === 'linux' && !process.env.AI_SLICE_NATIVE_WAYLAND) {
  app.commandLine.appendSwitch('ozone-platform', 'x11');
}

let store; // initialized once app is ready (needs userData path)

/** The user's own profiles live in a writable dir outside the (read-only, root-
 *  owned) install, so they survive reinstalls/updates and don't need sudo. */
function userProfilesDir() {
  return path.join(app.getPath('userData'), 'profiles');
}

function loadProfilesFrom(dir, out, opts = {}) {
  let files;
  try { files = fs.readdirSync(dir); } catch { return; } // dir may not exist yet
  for (const f of files.filter((x) => x.endsWith('.json'))) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!p.id) continue;
      // Skip the shipped placeholder template so it never clutters the dropdown.
      if (opts.skipExample && (p.id.startsWith('REPLACE') || f === 'example.json')) continue;
      out[p.id] = p; // later dirs (user) override earlier ones (bundled)
    } catch { /* ignore an unparseable profile rather than crash the app */ }
  }
}

function loadPrinters() {
  const out = {};
  loadProfilesFrom(path.join(__dirname, '..', 'profiles'), out, { skipExample: true });
  loadProfilesFrom(userProfilesDir(), out, { skipExample: true }); // user profiles win; hide the seeded template
  return out;
}

/** On first run, seed the user profiles dir with the example template so people
 *  have something to copy and fill in. */
function seedUserProfiles() {
  const dir = userProfilesDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const dst = path.join(dir, 'example.json');
    const src = path.join(__dirname, '..', 'profiles', 'example.json');
    if (!fs.existsSync(dst) && fs.existsSync(src)) fs.copyFileSync(src, dst);
  } catch { /* non-fatal */ }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'AI Slice',
    backgroundColor: '#1a1b26',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  return win;
}

app.whenReady().then(() => {
  store = makeStore(app.getPath('userData'));
  seedUserProfiles();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------- IPC handlers ----------------

ipcMain.handle('providers:list', () => llm.PROVIDERS);
ipcMain.handle('printers:list', () => loadPrinters());

// Which providers currently have a saved key (returns booleans, never the key).
ipcMain.handle('keys:status', () => {
  const status = {};
  for (const id of Object.keys(llm.PROVIDERS)) status[id] = store.hasKey(id);
  return status;
});
ipcMain.handle('keys:set', (_e, { provider, key }) => {
  store.setKey(provider, key);
  return { ok: true, hasKey: store.hasKey(provider) };
});

ipcMain.handle('prefs:get', () => store.getPrefs());
ipcMain.handle('prefs:set', (_e, prefs) => { store.setPrefs(prefs); return { ok: true }; });

ipcMain.handle('model:pick', async () => {
  const r = await dialog.showOpenDialog({
    title: 'Choose an STL model',
    filters: [{ name: 'STL', extensions: ['stl'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const file = r.filePaths[0];
  return { file, analysis: stl.analyzeFile(file) };
});

ipcMain.handle('model:analyze', (_e, file) => stl.analyzeFile(file));

// Read raw STL bytes for the 3D viewer in the renderer.
ipcMain.handle('model:bytes', (_e, file) => fs.readFileSync(file).buffer);

// Ask the selected LLM for optimized parameters. The key is read from the secret
// store on the main side and passed straight to the network call - it is never
// written anywhere committable.
ipcMain.handle('ai:optimize', async (_e, { provider, baseUrl, model, printerId, materialId, analysis, goal }) => {
  const printers = loadPrinters();
  const printer = printers[printerId];
  const material = printer.materials[materialId];
  const apiKey = store.getKey(provider);
  const params = await llm.optimizeSlicing(
    { provider, baseUrl, model, apiKey },
    { printer, material, analysis, goal }
  );
  return params;
});

ipcMain.handle('slice:run', async (_e, { stlPath, params, printerId, materialId }) => {
  const printers = loadPrinters();
  const printer = printers[printerId];
  const material = printer.materials[materialId];
  const outPath = stlPath.replace(/\.stl$/i, '') + '.ai.gcode';
  return slicer.slice({ stlPath, outPath, params, printer, material });
});

// Save the AI parameter set as a shareable JSON profile next to the model.
ipcMain.handle('profile:save', async (_e, { params, defaultDir }) => {
  const r = await dialog.showSaveDialog({
    title: 'Save AI slicing profile',
    defaultPath: path.join(defaultDir || app.getPath('documents'), 'ai-slice-profile.json'),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, JSON.stringify(params, null, 2));
  return r.filePath;
});
