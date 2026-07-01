# AI Slice

Desktop app that **optimizes 3D-model slicing for your specific printer using an
LLM, then slices to real G-code** via CuraEngine.

Load an STL → the app measures it (size, volume, overhangs, whether it needs
support and fits the bed) → sends that geometry + your printer profile to the LLM
you choose → gets back optimized slicing parameters → runs CuraEngine to produce
printable G-code.

## Features

- **3D preview** of the model on a to-scale print bed (three.js).
- **Real geometry analysis** — bounding box, volume, triangle count, overhang
  fraction, support/fit checks (dependency-free binary + ASCII STL parser).
- **Bring any AI key** — Anthropic (Claude), OpenAI, local Ollama (no key), or any
  OpenAI-compatible endpoint via *Custom* + Base URL.
- **Printer-aware** — profiles capture build volume, firmware quirks (e.g. Klipper
  rejecting Marlin-only `M201/M203/M205`), and your calibrated start/end G-code.
- **End-to-end G-code** through CuraEngine, or export the AI profile as JSON.

## Run

```bash
npm install
npm start
```

On a headless/GPU-less box add `--disable-gpu`:
`./node_modules/.bin/electron . --disable-gpu`

## Printer profiles

`profiles/*.json` describe your machine + materials. **They are git-ignored** —
only `profiles/example.json` (a placeholder template) is committed, because temps,
z-offset and start G-code must be calibrated per machine and should never be copied
blindly. To add your printer:

```bash
cp profiles/example.json profiles/my-printer.json   # then fill in REAL values
```

The app loads every `profiles/*.json` at startup.

## Slicing engine

Real G-code needs a slicing kernel — this app drives **CuraEngine** (it does not
reimplement one). If CuraEngine isn't found, the app still builds the full profile
and shows the exact command to run.

Install: `sudo apt install cura-engine` (Debian/Ubuntu), or point `CURAENGINE` at a
binary.

## Secrets

API keys are stored in your per-user app-data dir
(`~/.config/ai-slice/secrets.json`, mode `0600`) — **outside** the repo, and also
git-ignored as a second line of defence. Keys never travel to the renderer; only a
"have key / no key" boolean does.

## Layout

```
electron/main.js     Electron main process + IPC
electron/preload.js  Secure IPC bridge (contextIsolation)
lib/stl.js           STL parse + geometry analysis
lib/llm.js           Multi-provider LLM client (fetch, no SDK)
lib/slicer.js        AI params → CuraEngine → G-code
lib/store.js         Secret-safe config store
src/                 UI (viewer + controls)
profiles/            Printer/material profiles (git-ignored except example)
```
