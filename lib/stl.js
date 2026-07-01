'use strict';
// Minimal, dependency-free STL parser + geometry analysis.
// Supports both binary and ASCII STL. Runs in the Electron main process (Node).

const fs = require('fs');

/** Detect ASCII vs binary STL. Binary check is the reliable one: file size must
 *  equal 84 + 50 * triangleCount. */
function isBinary(buf) {
  if (buf.length < 84) return false;
  const triangles = buf.readUInt32LE(80);
  const expected = 84 + triangles * 50;
  if (expected === buf.length) return true;
  // Fall back to sniffing for the word "solid" at the very start (ASCII marker).
  const head = buf.slice(0, 5).toString('ascii').toLowerCase();
  return head !== 'solid';
}

function parseBinary(buf) {
  const triangles = buf.readUInt32LE(80);
  const positions = new Float32Array(triangles * 9);
  const normals = new Float32Array(triangles * 3);
  let offset = 84;
  for (let i = 0; i < triangles; i++) {
    const nx = buf.readFloatLE(offset);
    const ny = buf.readFloatLE(offset + 4);
    const nz = buf.readFloatLE(offset + 8);
    normals[i * 3] = nx; normals[i * 3 + 1] = ny; normals[i * 3 + 2] = nz;
    offset += 12;
    for (let v = 0; v < 3; v++) {
      positions[i * 9 + v * 3] = buf.readFloatLE(offset);
      positions[i * 9 + v * 3 + 1] = buf.readFloatLE(offset + 4);
      positions[i * 9 + v * 3 + 2] = buf.readFloatLE(offset + 8);
      offset += 12;
    }
    offset += 2; // attribute byte count
  }
  return { positions, normals, triangleCount: triangles };
}

function parseAscii(text) {
  const verts = [];
  const norms = [];
  const re = /facet\s+normal\s+([\-\d.eE+]+)\s+([\-\d.eE+]+)\s+([\-\d.eE+]+)[\s\S]*?vertex\s+([\-\d.eE+]+)\s+([\-\d.eE+]+)\s+([\-\d.eE+]+)\s+vertex\s+([\-\d.eE+]+)\s+([\-\d.eE+]+)\s+([\-\d.eE+]+)\s+vertex\s+([\-\d.eE+]+)\s+([\-\d.eE+]+)\s+([\-\d.eE+]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    norms.push(+m[1], +m[2], +m[3]);
    for (let i = 4; i <= 12; i++) verts.push(+m[i]);
  }
  return {
    positions: Float32Array.from(verts),
    normals: Float32Array.from(norms),
    triangleCount: norms.length / 3,
  };
}

/** Compute signed volume of a closed mesh via the divergence/tetrahedron method. */
function computeVolume(positions, triangleCount) {
  let vol = 0;
  for (let i = 0; i < triangleCount; i++) {
    const o = i * 9;
    const ax = positions[o], ay = positions[o + 1], az = positions[o + 2];
    const bx = positions[o + 3], by = positions[o + 4], bz = positions[o + 5];
    const cx = positions[o + 6], cy = positions[o + 7], cz = positions[o + 8];
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return Math.abs(vol); // mm^3
}

/** Estimate how much of the model overhangs and would need support.
 *  A downward-facing triangle (normal.z below -cos(threshold)) beyond the overhang
 *  angle needs support. Returns a fraction of total surface area that is unsupported. */
function analyzeOverhangs(positions, normals, triangleCount, overhangAngleDeg = 45) {
  const cosThresh = Math.cos((overhangAngleDeg * Math.PI) / 180);
  let overhangArea = 0;
  let totalArea = 0;
  for (let i = 0; i < triangleCount; i++) {
    const o = i * 9;
    // triangle area via cross product
    const ux = positions[o + 3] - positions[o], uy = positions[o + 4] - positions[o + 1], uz = positions[o + 5] - positions[o + 2];
    const vx = positions[o + 6] - positions[o], vy = positions[o + 7] - positions[o + 1], vz = positions[o + 8] - positions[o + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const area = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
    totalArea += area;
    // normalized face normal z
    let nz = normals[i * 3 + 2];
    const nlen = Math.hypot(normals[i * 3], normals[i * 3 + 1], nz) || 1;
    nz /= nlen;
    // downward-facing surface steeper than the overhang angle
    if (nz < -cosThresh) overhangArea += area;
  }
  return {
    overhangFraction: totalArea > 0 ? overhangArea / totalArea : 0,
    totalAreaMm2: totalArea,
  };
}

/** Load an STL file and return a full geometry analysis object. */
function analyzeFile(filePath) {
  const buf = fs.readFileSync(filePath);
  const geo = isBinary(buf) ? parseBinary(buf) : parseAscii(buf.toString('utf8'));
  const { positions, normals, triangleCount } = geo;

  // bounding box
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const size = { x: maxX - minX, y: maxY - minY, z: maxZ - minZ };
  const volumeMm3 = computeVolume(positions, triangleCount);
  const overhang = analyzeOverhangs(positions, normals, triangleCount);

  // A "tall & thin" model (footprint small vs height) is wobble-prone -> AI should
  // consider brim / slower speed. Compute an aspect ratio as a hint.
  const footprint = Math.max(size.x, size.y);
  const aspectRatio = footprint > 0 ? size.z / footprint : 0;

  return {
    file: filePath,
    format: isBinary(buf) ? 'binary' : 'ascii',
    triangleCount,
    boundingBoxMm: size,
    volumeMm3,
    volumeCm3: volumeMm3 / 1000,
    footprintMm: footprint,
    aspectRatio,
    overhangFraction: overhang.overhangFraction,
    surfaceAreaMm2: overhang.totalAreaMm2,
    needsSupport: overhang.overhangFraction > 0.03,
  };
}

module.exports = { analyzeFile, isBinary, parseBinary, parseAscii };
