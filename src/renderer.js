// Vendored three.js (src/vendor/three/) instead of ../node_modules — electron-
// builder strips three/examples/ from the packaged app, and the stock loaders use
// a bare `from 'three'` specifier that a CSP'd renderer can't resolve without an
// import map. The vendored loaders are patched to import './three.module.js'.
import * as THREE from './vendor/three/three.module.js';
import { STLLoader } from './vendor/three/STLLoader.js';
import { OrbitControls } from './vendor/three/OrbitControls.js';

const api = window.ai;
const $ = (id) => document.getElementById(id);

const state = {
  file: null,
  analysis: null,
  printers: {},
  providers: {},
  params: null,
};

// ---------------- logging ----------------
function log(msg, cls = '') {
  const el = $('log');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

// ---------------- 3D viewer ----------------
let scene, camera, renderer, controls, meshObj, bedObj;
function initViewer() {
  const host = $('viewer');
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, host.clientWidth / host.clientHeight, 0.1, 5000);
  camera.position.set(200, 200, 260);
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(host.clientWidth, host.clientHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  host.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  scene.add(new THREE.HemisphereLight(0xbbccff, 0x223344, 1.1));
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(1, 1.5, 1);
  scene.add(dir);

  window.addEventListener('resize', () => {
    camera.aspect = host.clientWidth / host.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(host.clientWidth, host.clientHeight);
  });
  (function loop() {
    requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  })();
}

function drawBed(bv) {
  if (!scene) return; // 3D viewer failed to init; skip preview
  if (bedObj) scene.remove(bedObj);
  bedObj = new THREE.Group();
  const grid = new THREE.GridHelper(Math.max(bv.x, bv.y), 20, 0x3b4261, 0x2a2e42);
  grid.position.set(bv.x / 2, 0, bv.y / 2);
  bedObj.add(grid);
  // Center the whole scene roughly on the bed.
  bedObj.add(grid);
  scene.add(bedObj);
  controls.target.set(bv.x / 2, 40, bv.y / 2);
}

function showModel(arrayBuffer, bv) {
  if (!scene) return; // 3D viewer failed to init; analysis/slicing still work
  if (meshObj) { scene.remove(meshObj); meshObj.geometry.dispose(); }
  const geo = new STLLoader().parse(arrayBuffer);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  // Sit the model on the bed (z-up STL → three is y-up, so rotate -90° x).
  const mat = new THREE.MeshStandardMaterial({ color: 0x7aa2f7, metalness: 0.1, roughness: 0.6, flatShading: false });
  meshObj = new THREE.Mesh(geo, mat);
  meshObj.rotation.x = -Math.PI / 2;
  // place footprint near bed corner origin
  meshObj.position.set(bv.x / 2 - (bb.min.x + bb.max.x) / 2, -bb.min.z, bv.y / 2 + (bb.min.y + bb.max.y) / 2);
  scene.add(meshObj);
  $('viewer-hint').classList.add('hidden');
}

// ---------------- data population ----------------
async function boot() {
  // 3D preview is optional — never let a WebGL failure block the controls/slicing.
  try { initViewer(); } catch (e) { log('3D preview unavailable: ' + e.message, 'warn'); }
  state.providers = await api.listProviders();
  state.printers = await api.listPrinters();

  const printerSel = $('printer');
  for (const [id, p] of Object.entries(state.printers)) {
    printerSel.add(new Option(p.name, id));
  }
  populateMaterials();
  printerSel.onchange = () => { populateMaterials(); refreshFit(); };

  const provSel = $('provider');
  for (const [id, p] of Object.entries(state.providers)) provSel.add(new Option(p.label, id));
  provSel.onchange = onProviderChange;

  // restore prefs
  const prefs = await api.getPrefs();
  if (prefs.printerId && state.printers[prefs.printerId]) printerSel.value = prefs.printerId;
  if (prefs.provider) provSel.value = prefs.provider;
  populateMaterials();
  if (prefs.materialId) $('material').value = prefs.materialId;
  onProviderChange();
  if (prefs.goal) $('goal').value = prefs.goal;

  drawBed(currentPrinter().machine.build_volume_mm);
  await refreshKeyStatus();
  await refreshEngineBadge();
}

function currentPrinter() { return state.printers[$('printer').value]; }

function populateMaterials() {
  const mSel = $('material');
  mSel.innerHTML = '';
  const mats = currentPrinter().materials;
  for (const [id, m] of Object.entries(mats)) mSel.add(new Option(m.name, id));
}

function onProviderChange() {
  const p = state.providers[$('provider').value];
  const modelSel = $('model');
  modelSel.innerHTML = '';
  (p.models.length ? p.models : ['(enter in Base URL config)']).forEach((m) => modelSel.add(new Option(m, m)));
  // custom / no-key providers
  const isCustom = $('provider').value === 'custom';
  $('baseurl-row').classList.toggle('hidden', !isCustom);
  const needsKey = p.keyEnv !== null || isCustom;
  $('key-row').classList.toggle('hidden', !needsKey && $('provider').value === 'ollama');
  refreshKeyStatus();
}

async function refreshKeyStatus() {
  const status = await api.keyStatus();
  const prov = $('provider').value;
  const el = $('key-status');
  if (prov === 'ollama') { el.textContent = 'Local Ollama — no key needed.'; return; }
  el.textContent = status[prov] ? '✓ key saved on this machine (not in git)' : 'no key saved yet';
  el.style.color = status[prov] ? 'var(--ok)' : 'var(--muted)';
}

async function refreshEngineBadge() {
  // ask a lightweight slice dry check by reading engine presence indirectly:
  // reuse a tiny call — we infer from a slice attempt only when needed, so here
  // just label optimistically; real status is reported after first slice.
  $('engine-badge').textContent = 'CuraEngine: click Slice to detect';
}

// ---------------- stats ----------------
function refreshFit() {
  if (!state.analysis) return;
  const bv = currentPrinter().machine.build_volume_mm;
  const s = state.analysis.boundingBoxMm;
  const fits = s.x <= bv.x && s.y <= bv.y && s.z <= bv.z;
  $('s-fit').textContent = fits ? '✓ yes' : '✗ too big!';
  $('s-fit').style.color = fits ? 'var(--ok)' : 'var(--err)';
}

function showStats(a) {
  $('stats').classList.remove('hidden');
  const s = a.boundingBoxMm;
  $('s-size').textContent = `${s.x.toFixed(1)} × ${s.y.toFixed(1)} × ${s.z.toFixed(1)}`;
  $('s-vol').textContent = `${a.volumeCm3.toFixed(1)} cm³`;
  $('s-tris').textContent = a.triangleCount.toLocaleString();
  $('s-over').textContent = `${(a.overhangFraction * 100).toFixed(1)}%`;
  $('s-sup').textContent = a.needsSupport ? 'likely' : 'no';
  $('s-sup').style.color = a.needsSupport ? 'var(--warn)' : 'var(--ok)';
  refreshFit();
}

// ---------------- actions ----------------
$('btn-load').onclick = async () => {
  const picked = await api.pickModel();
  if (!picked) return;
  state.file = picked.file;
  state.analysis = picked.analysis;
  log(`Loaded ${picked.file.split('/').pop()}`);
  showStats(picked.analysis);
  const bv = currentPrinter().machine.build_volume_mm;
  drawBed(bv);
  const bytes = await api.modelBytes(picked.file);
  showModel(bytes, bv);
  $('btn-optimize').disabled = false;
};

$('btn-savekey').onclick = async () => {
  const key = $('apikey').value.trim();
  if (!key) return;
  await api.setKey($('provider').value, key);
  $('apikey').value = '';
  log('API key saved locally (never committed).', 'ok');
  refreshKeyStatus();
};

$('btn-optimize').onclick = async () => {
  if (!state.analysis) return;
  await savePrefs();
  const provider = $('provider').value;
  $('btn-optimize').disabled = true;
  log(`Asking ${state.providers[provider].label} to optimize…`);
  try {
    const params = await api.optimize({
      provider,
      baseUrl: $('baseurl').value.trim() || undefined,
      model: $('model').value,
      printerId: $('printer').value,
      materialId: $('material').value,
      analysis: state.analysis,
      goal: $('goal').value,
    });
    state.params = params;
    renderParams(params);
    log('AI parameters ready.', 'ok');
    $('btn-slice').disabled = false;
    $('btn-saveprofile').disabled = false;
  } catch (e) {
    log('Optimize failed: ' + e.message, 'err');
  } finally {
    $('btn-optimize').disabled = false;
  }
};

function renderParams(p) {
  const box = $('params');
  box.classList.remove('hidden');
  const keys = [
    ['layer_height_mm', 'Layer height'],
    ['initial_layer_height_mm', 'Initial layer'],
    ['line_width_mm', 'Line width'],
    ['wall_count', 'Walls'],
    ['top_bottom_layers', 'Top/bottom'],
    ['infill_density_pct', 'Infill %'],
    ['infill_pattern', 'Infill pattern'],
    ['nozzle_temp_c', 'Nozzle °C'],
    ['bed_temp_c', 'Bed °C'],
    ['print_speed_mms', 'Speed mm/s'],
    ['initial_layer_speed_mms', 'First-layer mm/s'],
    ['retraction_distance_mm', 'Retraction mm'],
    ['retraction_speed_mms', 'Retract mm/s'],
    ['fan_speed_pct', 'Fan %'],
    ['supports_enabled', 'Supports'],
    ['support_angle_deg', 'Support angle'],
    ['adhesion', 'Adhesion'],
  ];
  const rows = keys
    .filter(([k]) => p[k] !== undefined)
    .map(([k, label]) => `<div class="k">${label}</div><div class="v">${p[k]}</div>`)
    .join('');
  box.innerHTML = `<h4>AI-optimized parameters</h4><div class="grid">${rows}</div>` +
    (p.rationale ? `<div class="rationale">${escapeHtml(p.rationale)}</div>` : '');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

$('btn-slice').onclick = async () => {
  if (!state.params) return;
  $('btn-slice').disabled = true;
  log('Slicing with CuraEngine…');
  try {
    const r = await api.slice({
      stlPath: state.file,
      params: state.params,
      printerId: $('printer').value,
      materialId: $('material').value,
    });
    if (r.ok) {
      log('✓ G-code written: ' + r.gcodePath, 'ok');
      $('engine-badge').textContent = 'CuraEngine: ✓';
      $('engine-badge').className = 'badge ok';
    } else if (r.engineMissing) {
      log('CuraEngine not installed. Install it, then re-slice.', 'warn');
      log('Debian/Ubuntu:  sudo apt install cura-engine', 'warn');
      log('Command that would run:', 'warn');
      log(r.command);
      $('engine-badge').textContent = 'CuraEngine: not found';
      $('engine-badge').className = 'badge miss';
    } else {
      log('Slice error: ' + (r.stderr || 'unknown'), 'err');
    }
  } catch (e) {
    log('Slice failed: ' + e.message, 'err');
  } finally {
    $('btn-slice').disabled = false;
  }
};

$('btn-saveprofile').onclick = async () => {
  if (!state.params) return;
  const dir = state.file ? state.file.replace(/\/[^/]+$/, '') : undefined;
  const saved = await api.saveProfile({ params: state.params, defaultDir: dir });
  if (saved) log('Profile saved: ' + saved, 'ok');
};

async function savePrefs() {
  await api.setPrefs({
    printerId: $('printer').value,
    materialId: $('material').value,
    provider: $('provider').value,
    goal: $('goal').value,
  });
}

boot().catch((e) => log('Init error: ' + e.message, 'err'));
