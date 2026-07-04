'use strict';
// Headless CLI for AI Slice — analyze an STL and slice it to G-code without the
// GUI. Useful for batch jobs and for machines with no display.
//
//   node lib/cli.js <model.stl> [--printer cr10-smart] [--material esun-epla-matte]
//                               [--goal "..."] [--ai]
//
// Without --ai it slices with the material's calibrated BASELINE parameters (the
// same starting point the AI refines). With --ai it calls your configured LLM
// (needs a saved key) to optimize parameters first.

const fs = require('fs');
const path = require('path');
const stl = require('./stl');
const llm = require('./llm');
const slicer = require('./slicer');
const { makeStore } = require('./store');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function loadPrinter(id) {
  const p = path.join(__dirname, '..', 'profiles', id + '.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** Turn a material profile + geometry into a full parameter set (AI-schema shape). */
function baselineParams(material, printer, analysis) {
  return {
    layer_height_mm: material.layer_height_mm,
    initial_layer_height_mm: material.initial_layer_height_mm,
    line_width_mm: printer.machine.nozzle_diameter_mm,
    wall_count: 3,
    top_bottom_layers: 4,
    infill_density_pct: 15,
    infill_pattern: 'grid',
    nozzle_temp_c: material.nozzle_temp_c,
    bed_temp_c: material.bed_temp_c,
    print_speed_mms: material.print_speed_mms,
    initial_layer_speed_mms: material.initial_layer_speed_mms,
    retraction_distance_mm: material.retraction_distance_mm,
    retraction_speed_mms: material.retraction_speed_mms,
    fan_speed_pct: material.fan_speed_pct,
    supports_enabled: analysis.needsSupport,
    support_angle_deg: 45,
    adhesion: analysis.aspectRatio > 3 ? 'brim' : 'skirt',
    rationale: 'Baseline material parameters (no AI). Supports/adhesion set from geometry.',
  };
}

async function main() {
  const model = process.argv[2];
  if (!model || model.startsWith('--')) {
    console.error('usage: node lib/cli.js <model.stl> [--printer id] [--material id] [--ai] [--goal "..."]');
    process.exit(1);
  }
  const printerId = arg('printer', 'cr10-smart');
  const printer = loadPrinter(printerId);
  const materialId = arg('material', Object.keys(printer.materials)[0]);
  const material = printer.materials[materialId];
  const goal = arg('goal', 'balanced quality and speed');

  console.log(`\n▸ Analyzing ${path.basename(model)} …`);
  const analysis = stl.analyzeFile(model);
  const s = analysis.boundingBoxMm;
  const bv = printer.machine.build_volume_mm;
  const fits = s.x <= bv.x && s.y <= bv.y && s.z <= bv.z;
  console.log(`  size      ${s.x.toFixed(1)} × ${s.y.toFixed(1)} × ${s.z.toFixed(1)} mm  (${analysis.format} STL)`);
  console.log(`  volume    ${analysis.volumeCm3.toFixed(1)} cm³   triangles ${analysis.triangleCount.toLocaleString()}`);
  console.log(`  overhangs ${(analysis.overhangFraction * 100).toFixed(1)}%  → support ${analysis.needsSupport ? 'recommended' : 'not needed'}`);
  console.log(`  fits ${printer.name} bed: ${fits ? 'yes' : 'NO — too big!'}`);
  if (!fits) { console.error('\n✗ Model does not fit the build volume. Scale it down first.'); process.exit(2); }

  let params;
  const paramsFile = arg('params', null);
  if (typeof paramsFile === 'string') {
    // Pre-optimized parameters supplied directly (e.g. produced by an agent
    // acting as the slicing LLM). Same schema llm.optimizeSlicing() returns.
    params = JSON.parse(fs.readFileSync(paramsFile, 'utf8'));
    console.log(`\n▸ Using supplied optimized parameters: ${path.basename(paramsFile)}`);
    if (params.rationale) console.log('  ' + params.rationale);
  } else if (arg('ai', false)) {
    const store = makeStore();
    const provider = arg('provider', 'anthropic');
    const apiKey = store.getKey(provider);
    if (!apiKey && provider !== 'ollama') {
      console.error(`\n✗ No saved API key for "${provider}". Save one in the GUI or set it in ${store.secretsPath}`);
      process.exit(3);
    }
    console.log(`\n▸ Asking ${provider} to optimize for goal: "${goal}" …`);
    params = await llm.optimizeSlicing(
      { provider, apiKey, model: arg('model', undefined), baseUrl: arg('baseurl', undefined) },
      { printer, material, analysis, goal }
    );
    console.log('  ' + (params.rationale || '(no rationale)'));
  } else {
    params = baselineParams(material, printer, analysis);
    console.log('\n▸ Using baseline material parameters (pass --ai to optimize with an LLM).');
  }

  const outPath = model.replace(/\.stl$/i, '') + '.ai.gcode';
  console.log(`\n▸ Slicing with CuraEngine → ${path.basename(outPath)} …`);
  const r = await slicer.slice({ stlPath: model, outPath, params, printer, material });
  if (r.ok) {
    const kb = (fs.statSync(r.gcodePath).size / 1024).toFixed(0);
    const s = r.summary || {};
    console.log(`\n✓ Done. ${r.gcodePath}  (${kb} KB)`);
    if (s.printTime) console.log(`  print time   ${s.printTime}`);
    if (s.filamentMeters) console.log(`  filament     ${s.filamentMeters} m  (${s.filamentMm3} mm³)`);
  } else if (r.engineMissing) {
    console.error('\n✗ CuraEngine not found. Install it:  sudo apt install cura-engine');
    console.error('  Command that would run:\n  ' + r.command);
    process.exit(4);
  } else {
    console.error('\n✗ Slice failed:\n' + (r.stderr || 'unknown error'));
    process.exit(5);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
