'use strict';
// Slicing backend. AI produces optimized parameters; we translate them into
// CuraEngine settings and run it to produce real, printable G-code.
//
// End-to-end G-code needs a slicing kernel. We DON'T reimplement one - we drive
// CuraEngine (the same engine inside Ultimaker Cura). CuraEngine needs a printer
// *definition* JSON (which supplies the hundreds of default settings) via -j, plus
// a search path to resolve its `inherits` chain and extruder trains.
//
// We use the SYSTEM CuraEngine (`apt install cura-engine`, 5.0.0) paired with
// version-matched 5.0.0 definitions in resources50/. This is deliberately the
// stable, no-surprises path: an earlier attempt to run a newer engine extracted
// from the Cura AppImage via ld-linux segfaulted (mixing AppImage libs with system
// libs), so that approach was dropped.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Cura 5.0.0 definitions, matched to the system CuraEngine 5.0.0.
const RES_DIR = path.join(ROOT, 'resources50');
const DEFS_DIR = path.join(RES_DIR, 'definitions');
const EXTRUDERS_DIR = path.join(RES_DIR, 'extruders');

// CuraEngine 5.0.0 fills all defaults from the matched definition, so no
// frontend-computed settings need injecting here.
const DERIVED_DEFAULTS = {};

/** Resolve the CuraEngine binary. Returns { cmd, prelude } or null. */
function resolveEngine() {
  const candidates = [
    process.env.CURAENGINE,
    '/usr/bin/CuraEngine',
    '/usr/local/bin/CuraEngine',
    path.join(os.homedir(), 'Applications', 'CuraEngine'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return { cmd: c, prelude: [], kind: 'system' };
  }
  return null;
}

/**
 * Map our AI parameter object onto CuraEngine -s key=value settings. These are
 * OVERRIDES on top of the printer definition's defaults.
 */
function toCuraSettings(p, printer, material) {
  const bv = printer.machine.build_volume_mm;
  const s = {
    ...DERIVED_DEFAULTS,
    // machine geometry — the 5.0 creality_cr10 definition is a 300x300x400 CR-10;
    // override with this profile's real build volume (CR-10 Smart is 300x250x400).
    machine_width: bv.x,
    machine_depth: bv.y,
    machine_height: bv.z,
    machine_nozzle_size: printer.machine.nozzle_diameter_mm,
    material_diameter: printer.machine.filament_diameter_mm,
    // quality
    layer_height: p.layer_height_mm,
    layer_height_0: p.initial_layer_height_mm,
    line_width: p.line_width_mm ?? printer.machine.nozzle_diameter_mm,
    wall_line_count: p.wall_count,
    top_layers: p.top_bottom_layers,
    bottom_layers: p.top_bottom_layers,
    // infill
    infill_sparse_density: p.infill_density_pct,
    infill_pattern: p.infill_pattern,
    // temps
    material_print_temperature: p.nozzle_temp_c,
    material_print_temperature_layer_0: material.nozzle_temp_initial_c ?? p.nozzle_temp_c,
    material_bed_temperature: p.bed_temp_c,
    material_bed_temperature_layer_0: material.bed_temp_initial_c ?? p.bed_temp_c,
    // speed
    speed_print: p.print_speed_mms,
    speed_layer_0: p.initial_layer_speed_mms,
    speed_travel: material.travel_speed_mms ?? 150,
    // retraction
    retraction_enable: 'true',
    retraction_amount: p.retraction_distance_mm,
    retraction_speed: p.retraction_speed_mms,
    // cooling
    cool_fan_enabled: 'true',
    cool_fan_speed: p.fan_speed_pct,
    // supports
    support_enable: p.supports_enabled ? 'true' : 'false',
    support_angle: p.support_angle_deg ?? 45,
    // adhesion
    adhesion_type: p.adhesion,
  };
  // Inject the printer's OWN start/end G-code so we don't ship the definition's
  // Marlin default (which for Klipper includes unsupported M201/M203/M205).
  if (printer.start_gcode) s.machine_start_gcode = fillGcode(printer.start_gcode, p);
  if (printer.end_gcode) s.machine_end_gcode = printer.end_gcode;
  return s;
}

/** Substitute {nozzle_temp_0} / {bed_temp_0} placeholders in start G-code. */
function fillGcode(gcode, p) {
  return gcode
    .replaceAll('{nozzle_temp_0}', String(p.nozzle_temp_c))
    .replaceAll('{bed_temp_0}', String(p.bed_temp_c));
}

/** Resolve the Cura definition file for a printer profile. */
function definitionFor(printer) {
  const name = printer.cura_definition || 'fdmprinter';
  const file = path.join(DEFS_DIR, name + '.def.json');
  return fs.existsSync(file) ? file : null;
}

function buildArgs(defFile, settings, stlPath, outPath) {
  const args = ['slice', '-v', '-j', defFile, '-o', outPath];
  for (const [k, v] of Object.entries(settings)) args.push('-s', `${k}=${v}`);
  args.push('-l', stlPath);
  return args;
}

/**
 * Slice a model to G-code.
 * @returns { ok, gcodePath?, command, settings, stderr?, summary?, engineMissing? }
 */
function slice({ stlPath, outPath, params, printer, material }) {
  return new Promise((resolve) => {
    const settings = toCuraSettings(params, printer, material);
    const engine = resolveEngine();
    const defFile = definitionFor(printer);

    if (!engine) {
      resolve({ ok: false, engineMissing: true, settings, gcodePath: null,
        command: 'CuraEngine (not found). Install cura-engine or add engine/ from the Cura AppImage.' });
      return;
    }
    if (!defFile) {
      resolve({ ok: false, settings, gcodePath: null,
        stderr: `No Cura definition for printer "${printer.id}". Set "cura_definition" in the profile and ensure resources/definitions/<name>.def.json exists.` });
      return;
    }

    const args = [...engine.prelude, ...buildArgs(defFile, settings, stlPath, outPath)];
    const env = { ...process.env, CURA_ENGINE_SEARCH_PATH: `${DEFS_DIR}:${EXTRUDERS_DIR}` };
    const command = `${engine.cmd} ${args.join(' ')}`;

    execFile(engine.cmd, args, { env, maxBuffer: 1024 * 1024 * 128 }, (err, stdout, stderr) => {
      const out = `${stdout || ''}\n${stderr || ''}`;
      const wrote = fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
      if (!wrote) {
        resolve({ ok: false, engineMissing: false, command, settings, stderr: out.slice(-2000) });
        return;
      }
      patchHeader(outPath, out); // back-fill real bounds/time/filament in the header
      resolve({ ok: true, gcodePath: outPath, command, settings, summary: parseSummary(out) });
    });
  });
}

/**
 * CuraEngine's CLI writes the G-code header with sentinel placeholders
 * (;TIME:6666, ;MINX:2.14748e+06, ...) and never back-patches them. Print hosts
 * (Klipper/Mainsail/Fluidd) read those comments for the time/filament estimate and
 * preview bounds, so replace them with the real values CuraEngine reports in its
 * verbose "Gcode header after slicing:" block.
 */
function patchHeader(outPath, out) {
  const block = out.split('Gcode header after slicing:')[1];
  if (!block) return; // no verbose header captured; leave file as-is
  let content;
  try { content = fs.readFileSync(outPath, 'utf8'); } catch { return; }

  const numeric = ['TIME', 'MINX', 'MINY', 'MINZ', 'MAXX', 'MAXY', 'MAXZ'];
  for (const f of numeric) {
    const m = block.match(new RegExp(`;${f}:([\\-\\d.e+]+)`));
    if (m) content = content.replace(new RegExp(`^;${f}:.*$`, 'm'), `;${f}:${m[1]}`);
  }
  const fil = block.match(/;Filament used:\s*([\d.]+m)/);
  if (fil) content = content.replace(/^;Filament used:.*$/m, `;Filament used: ${fil[1]}`);

  try { fs.writeFileSync(outPath, content); } catch { /* leave original on failure */ }
}

/** Pull the human-readable print time / filament figures from engine output. */
function parseSummary(out) {
  const time = out.match(/Print time \(hr\|min\|s\):\s*(.+)/);
  const filamentMm = out.match(/Filament used:\s*([\d.]+)m/);
  const filamentVol = out.match(/Filament \(mm\^3\):\s*(\d+)/);
  return {
    printTime: time ? time[1].trim() : null,
    filamentMeters: filamentMm ? +filamentMm[1] : null,
    filamentMm3: filamentVol ? +filamentVol[1] : null,
  };
}

module.exports = { slice, resolveEngine, toCuraSettings, buildArgs, definitionFor };
