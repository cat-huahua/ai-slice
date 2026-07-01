'use strict';
// Slicing backend. AI produces optimized parameters; we translate them into
// CuraEngine settings and run it to produce real, printable G-code.
//
// End-to-end G-code needs a slicing kernel. We DON'T reimplement one - we drive
// CuraEngine (the same engine inside Ultimaker Cura). If it isn't installed we
// still write a ready-to-run command + a Cura-importable profile so nothing is lost.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Locate a CuraEngine binary. Returns the path or null. */
function findCuraEngine() {
  const candidates = [
    process.env.CURAENGINE,
    'CuraEngine',
    'curaengine',
    '/usr/bin/CuraEngine',
    '/usr/local/bin/CuraEngine',
    path.join(os.homedir(), 'Applications', 'CuraEngine'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (c.includes('/') && fs.existsSync(c)) return c;
      if (!c.includes('/')) return c; // rely on PATH; verified at run time
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Map our AI parameter object onto CuraEngine -s key=value settings.
 * CuraEngine uses millimetres and 0..1 fractions for many fields.
 */
function toCuraSettings(p, printer, material) {
  const bv = printer.machine.build_volume_mm;
  const s = {
    // machine
    machine_width: bv.x,
    machine_depth: bv.y,
    machine_height: bv.z,
    machine_nozzle_size: printer.machine.nozzle_diameter_mm,
    material_diameter: printer.machine.filament_diameter_mm,
    machine_center_is_zero: 'false',
    machine_gcode_flavor: 'RepRap',
    machine_start_gcode: fillGcode(printer.start_gcode, p),
    machine_end_gcode: printer.end_gcode,
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
    // material / temps
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
  return s;
}

/** Substitute {nozzle_temp_0} / {bed_temp_0} placeholders in start G-code. */
function fillGcode(gcode, p) {
  return gcode
    .replaceAll('{nozzle_temp_0}', String(p.nozzle_temp_c))
    .replaceAll('{bed_temp_0}', String(p.bed_temp_c));
}

/** Build the CuraEngine argument vector. */
function buildArgs(settings, stlPath, outPath) {
  const args = ['slice', '-v', '-o', outPath];
  for (const [k, v] of Object.entries(settings)) {
    args.push('-s', `${k}=${v}`);
  }
  args.push('-l', stlPath);
  return args;
}

/**
 * Slice a model to G-code.
 * @returns { ok, gcodePath?, command, settings, stderr?, engineMissing? }
 */
function slice({ stlPath, outPath, params, printer, material }) {
  return new Promise((resolve) => {
    const settings = toCuraSettings(params, printer, material);
    const engine = findCuraEngine();
    const args = buildArgs(settings, stlPath, outPath);
    const command = `${engine || 'CuraEngine'} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`;

    if (!engine) {
      // Persist the profile so nothing is lost; user can import/slice manually.
      resolve({ ok: false, engineMissing: true, command, settings, gcodePath: null });
      return;
    }

    execFile(engine, args, { maxBuffer: 1024 * 1024 * 64 }, (err, stdout, stderr) => {
      if (err && !fs.existsSync(outPath)) {
        resolve({ ok: false, engineMissing: false, command, settings, stderr: stderr || String(err) });
      } else {
        resolve({ ok: true, gcodePath: outPath, command, settings, stderr });
      }
    });
  });
}

module.exports = { slice, findCuraEngine, toCuraSettings, buildArgs };
