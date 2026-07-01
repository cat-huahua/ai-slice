'use strict';
// Secret-safe config store.
//
// API keys are written to the OS per-user app-data directory (Electron userData),
// which lives OUTSIDE the git repo, so a key can never be committed. As a second
// line of defence config/secrets.json is also in .gitignore.
//
// Non-secret preferences (provider, model, selected printer/material) are stored
// separately from the key so they can be shared/committed safely if desired.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Resolve the userData dir. When running under Electron, app.getPath('userData')
// is passed in; otherwise fall back to a per-user config dir. Either way it is
// never inside the project tree.
function resolveDir(electronUserDataDir) {
  if (electronUserDataDir) return electronUserDataDir;
  const base =
    process.env.XDG_CONFIG_HOME ||
    path.join(os.homedir(), '.config');
  return path.join(base, 'ai-slice');
}

function makeStore(electronUserDataDir) {
  const dir = resolveDir(electronUserDataDir);
  fs.mkdirSync(dir, { recursive: true });
  const secretsPath = path.join(dir, 'secrets.json'); // holds API keys only
  const prefsPath = path.join(dir, 'prefs.json'); // non-secret preferences

  function readJson(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
  }
  function writeJson(p, obj, mode) {
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), { mode });
  }

  return {
    dir,
    secretsPath,
    // --- secrets (API keys), stored per provider, file locked to 0600 ---
    getKey(provider) {
      return readJson(secretsPath)[provider] || '';
    },
    setKey(provider, key) {
      const s = readJson(secretsPath);
      if (key) s[provider] = key; else delete s[provider];
      writeJson(secretsPath, s, 0o600); // owner read/write only
    },
    hasKey(provider) {
      return Boolean(readJson(secretsPath)[provider]);
    },
    // --- non-secret preferences ---
    getPrefs() {
      return readJson(prefsPath);
    },
    setPrefs(prefs) {
      writeJson(prefsPath, prefs);
    },
  };
}

module.exports = { makeStore, resolveDir };
