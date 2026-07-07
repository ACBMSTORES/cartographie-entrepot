/* global THREE */
(async function () {
  "use strict";

  // ---------- 1. LOAD + PARSE DATA ----------
  // emplacements.txt is a pipe/newline delimited file, fetched at runtime (not
  // embedded) so an automated job can refresh just this one small file —
  // columns: emplacement|position|niveau|area|statut|allee|longueur|largeur|hauteur|actif|poids|typestockage
  let RAW_DATA, META;
  try {
    [RAW_DATA, META] = await Promise.all([
      fetch("./emplacements.txt", { cache: "no-store" }).then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      }),
      fetch("./meta.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]);
  } catch (err) {
    document.getElementById("loading").textContent = "Erreur de chargement des données (emplacements.txt) : " + err.message;
    return;
  }

  const lines = RAW_DATA.replace(/\r/g, "").trim().split("\n");
  const N = lines.length;

  const emplacements = new Array(N);
  const positionArr = new Int32Array(N);
  const niveauArr = new Int32Array(N);
  const areaArr = new Array(N); // e.g. 'BJ-STOCK', 'BJ-PICK', 'AU-STOCK', 'AU-PICK'
  const statutArr = new Array(N); // 'E','F','P','I','X'
  const alleeArr = new Array(N);
  const lArr = new Float32Array(N);
  const wArr = new Float32Array(N);
  const hArr = new Float32Array(N);
  const actifArr = new Uint8Array(N);
  const poidsArr = new Int32Array(N);
  const stypeArr = new Array(N);

  for (let i = 0; i < N; i++) {
    const f = lines[i].split("|");
    emplacements[i] = f[0];
    positionArr[i] = parseInt(f[1], 10) || 0;
    niveauArr[i] = parseInt(f[2], 10) || 0;
    areaArr[i] = f[3] || "NON_DEFINI";
    statutArr[i] = f[4];
    alleeArr[i] = f[5];
    lArr[i] = parseFloat(f[6]);
    wArr[i] = parseFloat(f[7]);
    hArr[i] = parseFloat(f[8]);
    actifArr[i] = parseInt(f[9], 10);
    poidsArr[i] = parseInt(f[10], 10) || 0;
    stypeArr[i] = f[11] || "NON_DEFINI";
  }

  // ---------- 2. BUILD SPATIAL LAYOUT ----------
  // No explicit X/Y/Z is present in the source file, so we reconstruct a
  // schematic-but-consistent layout from allee (aisle code) + position (slot
  // along the aisle) + niveau (shelf level). The 10 "cellules" (block letters
  // A-J found in the allee codes) are arranged on the floor exactly as in the
  // reference plan: A,B,C,D on the front row, E,F,G,H behind them, and I,J as
  // two tall cells spanning the full depth on the right-hand side.
  const alleeSet = new Set(alleeArr);
  alleeSet.delete("");
  const alleeList = Array.from(alleeSet).sort();

  // group by first letter (cellule) then second letter (sub-aisle)
  const blocks = new Map(); // cellule letter -> Set(subLetters)
  alleeList.forEach((a) => {
    const b = a[0] || "?";
    const sub = a[1] || "?";
    if (!blocks.has(b)) blocks.set(b, new Set());
    blocks.get(b).add(sub);
  });

  const GAP = 0.5; // requested clearance between two neighbouring emplacements, in meters
  const AISLE_PITCH = 1.2 + GAP; // meters between two adjacent aisles (based on typical 'largeur' 120cm + gap)
  const SLOT_PITCH = 0.8 + GAP; // meters between two consecutive slots along an aisle (based on typical 'longueur' 80cm + gap)
  const COL_GAP = 6; // cross-aisle gap between columns of cellules within the same depot
  const DEPOT_GAP = 30; // 3000cm gap before the N/K/M/L block, which sits in a separate depot building

  let maxPosition = 1, maxHauteur = 1;
  for (let i = 0; i < N; i++) {
    if (positionArr[i] > maxPosition) maxPosition = positionArr[i];
    if (hArr[i] > maxHauteur) maxHauteur = hArr[i];
  }
  const LEVEL_HEIGHT = maxHauteur / 100 + GAP; // meters per shelf level (base-to-base), sized off the tallest box so no level ever overlaps the one above
  const CELL_DEPTH = maxPosition * SLOT_PITCH; // real depth of one A-H cellule, slot pitch included
  const ROW_GAP = CELL_DEPTH * 0.12; // cross-aisle gap between the front/back rows, scaled to stay visible at this depth

  // reference plan, left to right: 4 columns hold a pair of cellules each
  // (top/bottom), then 2 tall cellules spanning the full depth of both rows,
  // then a second 4-column block (2 columns of pairs) — as in the reference
  // diagram. Each entry is either {top, bottom} (two normal-depth cellules
  // stacked front/back) or {tall} (one cellule spanning both rows).
  const subsOf = (letter) => Array.from(blocks.get(letter) || []).sort();
  const rowZ = [0, CELL_DEPTH + ROW_GAP];
  const totalDepth = CELL_DEPTH * 2 + ROW_GAP;

  // real max "position" reached by a given cellule's own aisles — used for
  // the N/K/M/L block below, whose cellules are far from uniform in size
  // (e.g. N only has 4 short aisles, M has 15 much longer ones) and must be
  // drawn at their true relative proportions rather than a shared size.
  const maxPositionOf = (letter) => {
    let m = 1;
    for (let i = 0; i < N; i++) {
      if (alleeArr[i][0] === letter && positionArr[i] > m) m = positionArr[i];
    }
    return m;
  };

  // The N/K/M/L block sits in a separate depot, so its front row is anchored
  // so that N's very first emplacement (position 1) lands exactly level with
  // J's very last emplacement (J is a tall cellule, its max position reaches
  // z = totalDepth) — rather than restarting at z = 0 like the main block.
  const DEPOT2_FRONT_Z = totalDepth - SLOT_PITCH;

  const COLUMNS = [
    { top: "A", bottom: "E" },
    { top: "B", bottom: "F" },
    { top: "C", bottom: "G" },
    { top: "D", bottom: "H" },
    { tall: "I" },
    { tall: "J" },
    { top: "N", bottom: "M", gapBefore: DEPOT_GAP, frontZ: DEPOT2_FRONT_Z, ownDepth: true },
    { top: "K", bottom: "L", frontZ: DEPOT2_FRONT_Z, ownDepth: true },
  ];

  // zPitch = meters advanced per unit of the raw "position" field. Normal
  // cellules use the real slot pitch (so consecutive emplacements keep
  // exactly GAP meters of clearance); tall cellules are stretched so they
  // visually span the full depth of both rows, without ever overlapping.
  const cellOrigin = new Map(); // cellule letter -> {x, z, depth, zPitch}
  let cursorX = 0;
  COLUMNS.forEach((col, idx) => {
    if (idx > 0) cursorX += col.gapBefore != null ? col.gapBefore : COL_GAP;
    if (col.tall) {
      const width = Math.max(subsOf(col.tall).length, 1) * AISLE_PITCH;
      cellOrigin.set(col.tall, { x: cursorX, z: 0, depth: totalDepth, zPitch: totalDepth / maxPosition });
      cursorX += width;
    } else if (col.ownDepth) {
      // each cellule keeps its own true width and depth; the bottom one
      // simply starts right after the top one's own depth ends.
      const topDepth = maxPositionOf(col.top) * SLOT_PITCH;
      const bottomDepth = maxPositionOf(col.bottom) * SLOT_PITCH;
      const topWidth = Math.max(subsOf(col.top).length, 1) * AISLE_PITCH;
      const bottomWidth = Math.max(subsOf(col.bottom).length, 1) * AISLE_PITCH;
      const frontZ = col.frontZ != null ? col.frontZ : 0;
      cellOrigin.set(col.top, { x: cursorX, z: frontZ, depth: topDepth, zPitch: SLOT_PITCH });
      cellOrigin.set(col.bottom, { x: cursorX, z: frontZ + topDepth + ROW_GAP, depth: bottomDepth, zPitch: SLOT_PITCH });
      cursorX += Math.max(topWidth, bottomWidth);
    } else {
      const width = Math.max(subsOf(col.top).length, subsOf(col.bottom).length, 1) * AISLE_PITCH;
      cellOrigin.set(col.top, { x: cursorX, z: rowZ[0], depth: CELL_DEPTH, zPitch: SLOT_PITCH });
      cellOrigin.set(col.bottom, { x: cursorX, z: rowZ[1], depth: CELL_DEPTH, zPitch: SLOT_PITCH });
      cursorX += width;
    }
  });

  const CELLULE_COLOR = {
    A: "#4f86c6", B: "#7fa96b", C: "#efc94c", D: "#ef8a76",
    E: "#b39ddb", F: "#5bc8e8", G: "#e399b8", H: "#f2a73b",
    I: "#94a3ad", J: "#6fcf97",
    N: "#ffd166", K: "#ef476f", M: "#06d6a0", L: "#118ab2",
  };

  const alleeY = new Map(); // allee code -> {x, z, depth, zPitch} origin (base of that aisle)
  blocks.forEach((subsSet, letter) => {
    const origin = cellOrigin.get(letter);
    if (!origin) return; // unexpected block letter outside the reference plan
    subsOf(letter).forEach((s, idx) => {
      alleeY.set(letter + s, { x: origin.x + idx * AISLE_PITCH, z: origin.z, depth: origin.depth, zPitch: origin.zPitch });
    });
  });
  // special/junk locations with no allee -> put in a dedicated far corner
  const JUNK_ORIGIN = { x: -8, z: -8, depth: CELL_DEPTH, zPitch: SLOT_PITCH };

  // ---------- 3. COMPUTE PER-INSTANCE TRANSFORMS + COLORS ----------
  const STATUT_COLOR = {
    E: 0x2ecc71, // empty - green
    F: 0xe74c3c, // full - red
    P: 0xf39c12, // partial - orange
    I: 0x9b59b6, // unknown/blocked - purple
    X: 0x7f8c8d, // fallback
  };
  const posX = new Float32Array(N);
  const posY = new Float32Array(N);
  const posZ = new Float32Array(N);
  const dimX = new Float32Array(N);
  const dimY = new Float32Array(N);
  const dimZ = new Float32Array(N);
  const colorArr = new Float32Array(N * 3);

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

  for (let i = 0; i < N; i++) {
    const allee = alleeArr[i];
    const origin = allee && alleeY.has(allee) ? alleeY.get(allee) : JUNK_ORIGIN;
    const x = origin.x;
    const y = origin.z + positionArr[i] * origin.zPitch;
    const z = niveauArr[i] * LEVEL_HEIGHT + hArr[i] / 200; // base + half height

    posX[i] = x;
    posY[i] = z; // three.js Y = up
    posZ[i] = y; // three.js Z = warehouse depth

    dimX[i] = Math.max(0.3, wArr[i] / 100);
    dimY[i] = Math.max(0.2, hArr[i] / 100);
    dimZ[i] = Math.max(0.3, lArr[i] / 100);

    const c = STATUT_COLOR[statutArr[i]] || STATUT_COLOR.X;
    const r = ((c >> 16) & 255) / 255, g = ((c >> 8) & 255) / 255, b = (c & 255) / 255;
    colorArr[i * 3] = r;
    colorArr[i * 3 + 1] = g;
    colorArr[i * 3 + 2] = b;

    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  // ---------- 4. THREE.JS SCENE ----------
  const canvasHost = document.getElementById("scene-host");
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e1420);

  const centerX = (minX + maxX) / 2;
  const centerZ = (minY + maxY) / 2;
  const spanDiag = Math.sqrt(Math.pow(maxX - minX, 2) + Math.pow(maxY - minY, 2));

  scene.fog = new THREE.Fog(0x0e1420, spanDiag * 0.4, spanDiag * 2.2);

  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, spanDiag * 6);
  camera.position.set(centerX - spanDiag * 0.45, spanDiag * 0.55, centerZ + spanDiag * 0.45);

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  canvasHost.appendChild(renderer.domElement);

  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.target.set(centerX, 0, centerZ);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxDistance = spanDiag * 3;
  controls.minDistance = 2;
  controls.update();

  scene.add(new THREE.AmbientLight(0xffffff, 0.65));
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(centerX + 60, 120, centerZ + 40);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x88aaff, 0.25);
  fill.position.set(centerX - 60, 40, centerZ - 60);
  scene.add(fill);

  // ground grid
  const gridSize = Math.max(maxX - minX, maxY - minY) + 40;
  const grid = new THREE.GridHelper(gridSize, Math.round(gridSize / 5), 0x2c3e50, 0x1a2432);
  grid.position.set(centerX, -0.05, centerZ);
  scene.add(grid);

  // ---------- 5. INSTANCED MESHES (active / inactive) ----------
  const activeIdx = [];
  const inactiveIdx = [];
  for (let i = 0; i < N; i++) (actifArr[i] ? activeIdx : inactiveIdx).push(i);

  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  boxGeo.translate(0, 0.5, 0); // pivot at base

  // NOTE: instanceColor is applied automatically by three.js whenever
  // InstancedMesh.instanceColor is set — do NOT set material.vertexColors
  // here, that flag instead expects a per-vertex geometry "color" attribute
  // (which this box geometry doesn't have) and would multiply everything to black.
  const activeMat = new THREE.MeshLambertMaterial({});
  const inactiveMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.18, depthWrite: false });

  // Position and scale for every instance are kept in plain typed arrays and
  // re-applied directly (never read back via getMatrixAt+decompose): once an
  // instance's scale is set to 0 to hide it, decompose() divides by that zero
  // scale internally and permanently corrupts the matrix with NaN, so it can
  // never be shown again. Composing fresh from stored numbers avoids that.
  function buildMesh(idxList, material) {
    const mesh = new THREE.InstancedMesh(boxGeo, material, idxList.length);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(idxList.length * 3), 3);
    const basePos = new Float32Array(idxList.length * 3);
    const baseScale = new Float32Array(idxList.length * 3);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (let k = 0; k < idxList.length; k++) {
      const i = idxList[k];
      const px = posX[i], py = posY[i] - hArr[i] / 200, pz = posZ[i];
      const sx = dimX[i], sy = dimY[i], sz = dimZ[i];
      basePos[k * 3] = px; basePos[k * 3 + 1] = py; basePos[k * 3 + 2] = pz;
      baseScale[k * 3] = sx; baseScale[k * 3 + 1] = sy; baseScale[k * 3 + 2] = sz;
      m.compose(new THREE.Vector3(px, py, pz), q, new THREE.Vector3(sx, sy, sz));
      mesh.setMatrixAt(k, m);
      mesh.instanceColor.setXYZ(k, colorArr[i * 3], colorArr[i * 3 + 1], colorArr[i * 3 + 2]);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false;
    return { mesh, basePos, baseScale };
  }

  const activeBuild = buildMesh(activeIdx, activeMat);
  const inactiveBuild = buildMesh(inactiveIdx, inactiveMat);
  const activeMesh = activeBuild.mesh;
  const inactiveMesh = inactiveBuild.mesh;
  scene.add(activeMesh);
  scene.add(inactiveMesh);

  const activePos = activeBuild.basePos, activeScale = activeBuild.baseScale;
  const inactivePos = inactiveBuild.basePos, inactiveScale = inactiveBuild.baseScale;

  // ---------- 5b. LABELS (cellule letters + aisle names) ----------
  let maxShelfTop = 0;
  for (let i = 0; i < N; i++) {
    const top = niveauArr[i] * LEVEL_HEIGHT + hArr[i] / 100;
    if (top > maxShelfTop) maxShelfTop = top;
  }

  function makeTextSprite(text, { fontPx = 120, color = "#ffffff", bg = null, worldHeight = 3 } = {}) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    ctx.font = `bold ${fontPx}px -apple-system, Segoe UI, Arial, sans-serif`;
    const textW = ctx.measureText(text).width;
    canvas.width = Math.ceil(textW + fontPx * 0.6);
    canvas.height = Math.ceil(fontPx * 1.4);
    ctx.font = `bold ${fontPx}px -apple-system, Segoe UI, Arial, sans-serif`;
    if (bg) {
      ctx.fillStyle = bg;
      const r = fontPx * 0.25;
      ctx.beginPath();
      ctx.moveTo(r, 0);
      ctx.arcTo(canvas.width, 0, canvas.width, canvas.height, r);
      ctx.arcTo(canvas.width, canvas.height, 0, canvas.height, r);
      ctx.arcTo(0, canvas.height, 0, 0, r);
      ctx.arcTo(0, 0, canvas.width, 0, r);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
    const sprite = new THREE.Sprite(mat);
    const aspect = canvas.width / canvas.height;
    sprite.scale.set(worldHeight * aspect, worldHeight, 1);
    return sprite;
  }

  const labelGroup = new THREE.Group();
  scene.add(labelGroup);

  // large cellule letter, floating above each of the 10 zones
  cellOrigin.forEach((origin, letter) => {
    const width = subsOf(letter).length * AISLE_PITCH;
    const cx = origin.x + width / 2;
    const cz = origin.z + origin.depth / 2;
    const sprite = makeTextSprite(letter, {
      fontPx: 160,
      color: "#ffffff",
      bg: CELLULE_COLOR[letter] || "#546e7a",
      worldHeight: 5,
    });
    sprite.position.set(cx, maxShelfTop + 6, cz);
    sprite.renderOrder = 2;
    labelGroup.add(sprite);
  });

  // smaller aisle code, floating above the near end of each aisle
  alleeY.forEach((origin, code) => {
    const sprite = makeTextSprite(code, { fontPx: 90, color: "#ffe066", worldHeight: 1.5 });
    sprite.position.set(origin.x + AISLE_PITCH / 2, maxShelfTop + 1.2, origin.z - 0.5);
    sprite.renderOrder = 1;
    labelGroup.add(sprite);
  });

  document.getElementById("f-labels").addEventListener("change", (e) => {
    labelGroup.visible = e.target.checked;
  });

  // ---------- 5b2. ZONE FILTER (built from whatever area values are present in the data) ----------
  const zoneValues = Array.from(new Set(areaArr)).sort();
  const zoneContainer = document.getElementById("f-zone-container");
  zoneValues.forEach((z) => {
    const row = document.createElement("div");
    row.className = "row";
    const id = "f-zone-" + z.replace(/[^A-Z0-9]/gi, "_");
    row.innerHTML = '<input type="checkbox" id="' + id + '" checked data-zone="' + z + '"><label for="' + id + '" title="' + z + '">' + z + "</label>";
    zoneContainer.appendChild(row);
  });
  const zoneCheckboxes = Array.from(zoneContainer.querySelectorAll("input[type=checkbox]"));
  document.getElementById("zone-all").addEventListener("click", (e) => {
    e.preventDefault();
    zoneCheckboxes.forEach((cb) => (cb.checked = true));
    applyFilters();
  });
  document.getElementById("zone-none").addEventListener("click", (e) => {
    e.preventDefault();
    zoneCheckboxes.forEach((cb) => (cb.checked = false));
    applyFilters();
  });

  // ---------- 5c. STORAGE TYPE FILTER (built from whatever values are present in the data) ----------
  const storageTypes = Array.from(new Set(stypeArr)).sort();
  const typeContainer = document.getElementById("f-type-container");
  storageTypes.forEach((t) => {
    const row = document.createElement("div");
    row.className = "row";
    const id = "f-type-" + t.replace(/[^A-Z0-9]/gi, "_");
    row.innerHTML = '<input type="checkbox" id="' + id + '" checked data-type="' + t + '"><label for="' + id + '" title="' + t + '">' + t + "</label>";
    typeContainer.appendChild(row);
  });
  const typeCheckboxes = Array.from(typeContainer.querySelectorAll("input[type=checkbox]"));
  document.getElementById("type-all").addEventListener("click", (e) => {
    e.preventDefault();
    typeCheckboxes.forEach((cb) => (cb.checked = true));
    applyFilters();
  });
  document.getElementById("type-none").addEventListener("click", (e) => {
    e.preventDefault();
    typeCheckboxes.forEach((cb) => (cb.checked = false));
    applyFilters();
  });

  function applyFilters() {
    const wantStatut = {
      E: document.getElementById("f-e").checked,
      F: document.getElementById("f-f").checked,
      P: document.getElementById("f-p").checked,
      I: document.getElementById("f-i").checked,
    };
    const alleeFilter = document.getElementById("f-allee").value.trim().toUpperCase();
    const showInactive = document.getElementById("f-inactive").checked;
    inactiveMesh.visible = showInactive;

    const wantZone = {};
    zoneCheckboxes.forEach((cb) => (wantZone[cb.dataset.zone] = cb.checked));
    const wantType = {};
    typeCheckboxes.forEach((cb) => (wantType[cb.dataset.type] = cb.checked));

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    function pass(i) {
      if (!wantZone[areaArr[i]]) return false;
      const st = statutArr[i];
      if (wantStatut.hasOwnProperty(st) && !wantStatut[st]) return false;
      if (!wantType[stypeArr[i]]) return false;
      if (alleeFilter && !alleeArr[i].toUpperCase().includes(alleeFilter)) return false;
      return true;
    }

    function applyTo(mesh, idxList, pos, scale) {
      for (let k = 0; k < idxList.length; k++) {
        const i = idxList[k];
        const visible = pass(i);
        const sx = visible ? scale[k * 3] : 0, sy = visible ? scale[k * 3 + 1] : 0, sz = visible ? scale[k * 3 + 2] : 0;
        m.compose(
          new THREE.Vector3(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]),
          q,
          new THREE.Vector3(sx, sy, sz)
        );
        mesh.setMatrixAt(k, m);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }

    applyTo(activeMesh, activeIdx, activePos, activeScale);
    applyTo(inactiveMesh, inactiveIdx, inactivePos, inactiveScale);

    updateStats();
  }

  // ---------- 6. STATS ----------
  function updateStats() {
    let total = 0, act = 0, inact = 0, e = 0, f = 0, p = 0, other = 0, stock = 0, pick = 0;
    const wantZone = {};
    zoneCheckboxes.forEach((cb) => (wantZone[cb.dataset.zone] = cb.checked));
    const wantStatut = {
      E: document.getElementById("f-e").checked,
      F: document.getElementById("f-f").checked,
      P: document.getElementById("f-p").checked,
      I: document.getElementById("f-i").checked,
    };
    const alleeFilter = document.getElementById("f-allee").value.trim().toUpperCase();
    const wantType = {};
    typeCheckboxes.forEach((cb) => (wantType[cb.dataset.type] = cb.checked));
    for (let i = 0; i < N; i++) {
      const a = areaArr[i];
      if (!wantZone[a]) continue;
      const st = statutArr[i];
      if (wantStatut.hasOwnProperty(st) && !wantStatut[st]) continue;
      if (!wantType[stypeArr[i]]) continue;
      if (alleeFilter && !alleeArr[i].toUpperCase().includes(alleeFilter)) continue;
      total++;
      if (actifArr[i]) act++; else inact++;
      if (st === "E") e++; else if (st === "F") f++; else if (st === "P") p++; else other++;
      if (a.includes("STOCK")) stock++; else if (a.includes("PICK")) pick++;
    }
    document.getElementById("stat-total").textContent = total.toLocaleString("fr-FR");
    document.getElementById("stat-active").textContent = act.toLocaleString("fr-FR");
    document.getElementById("stat-inactive").textContent = inact.toLocaleString("fr-FR");
    document.getElementById("stat-e").textContent = e.toLocaleString("fr-FR");
    document.getElementById("stat-f").textContent = f.toLocaleString("fr-FR");
    document.getElementById("stat-p").textContent = p.toLocaleString("fr-FR");
    document.getElementById("stat-stock").textContent = stock.toLocaleString("fr-FR");
    document.getElementById("stat-pick").textContent = pick.toLocaleString("fr-FR");
    const fillPct = total ? Math.round(((f + p * 0.5) / total) * 100) : 0;
    document.getElementById("stat-fillpct").textContent = fillPct + "%";
  }

  ["f-e", "f-f", "f-p", "f-i", "f-inactive"].forEach((id) => {
    document.getElementById(id).addEventListener("change", applyFilters);
  });
  zoneCheckboxes.forEach((cb) => cb.addEventListener("change", applyFilters));
  typeCheckboxes.forEach((cb) => cb.addEventListener("change", applyFilters));
  document.getElementById("f-allee").addEventListener("input", applyFilters);

  // ---------- 7. SEARCH / LOCATE ----------
  const empIndex = new Map();
  for (let i = 0; i < N; i++) empIndex.set(emplacements[i], i);

  const marker = new THREE.Mesh(
    new THREE.RingGeometry(0.9, 1.15, 24),
    new THREE.MeshBasicMaterial({ color: 0xffe066, side: THREE.DoubleSide, transparent: true, opacity: 0.95 })
  );
  marker.rotation.x = -Math.PI / 2;
  marker.visible = false;
  scene.add(marker);

  function showDetails(i) {
    const panel = document.getElementById("details");
    panel.innerHTML =
      '<div class="det-row"><b>' + emplacements[i] + "</b></div>" +
      '<div class="det-row">Allée: ' + (alleeArr[i] || "-") + " &middot; Position: " + positionArr[i] + " &middot; Niveau: " + niveauArr[i] + "</div>" +
      '<div class="det-row">Zone: ' + areaArr[i] + " &middot; Type: " + stypeArr[i] + "</div>" +
      '<div class="det-row">Statut: ' + statutLabel(statutArr[i]) + "</div>" +
      '<div class="det-row">Etat: ' + (actifArr[i] ? "Actif" : "Inactif") + "</div>" +
      '<div class="det-row">Dimensions (LxlxH cm): ' + lArr[i] + " x " + wArr[i] + " x " + hArr[i] + "</div>" +
      '<div class="det-row">Poids max: ' + poidsArr[i] + " kg</div>";
    panel.style.display = "block";
  }

  function statutLabel(s) {
    return { E: "Vide (E)", F: "Plein (F)", P: "Partiel (P)", I: "Indispo (I)" }[s] || "Inconnu";
  }

  function locate(code) {
    const i = empIndex.get(code);
    if (i === undefined) {
      document.getElementById("search-msg").textContent = "Emplacement introuvable.";
      return;
    }
    document.getElementById("search-msg").textContent = "";
    marker.position.set(posX[i], niveauArr[i] * LEVEL_HEIGHT + 0.02, posZ[i]);
    marker.visible = true;
    const target = new THREE.Vector3(posX[i], posY[i], posZ[i]);
    controls.target.copy(target);
    const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
    camera.position.copy(target.clone().add(dir.multiplyScalar(10)));
    camera.position.y = Math.max(camera.position.y, target.y + 4);
    showDetails(i);
  }

  document.getElementById("search-btn").addEventListener("click", () => {
    const val = document.getElementById("search-box").value.trim().toUpperCase();
    if (val) locate(val);
  });
  document.getElementById("search-box").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("search-btn").click();
  });

  // ---------- 8. RAYCAST CLICK ----------
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  renderer.domElement.addEventListener("click", (ev) => {
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObjects([activeMesh, inactiveMesh]);
    if (hits.length) {
      const hit = hits[0];
      const list = hit.object === activeMesh ? activeIdx : inactiveIdx;
      const i = list[hit.instanceId];
      marker.position.set(posX[i], niveauArr[i] * LEVEL_HEIGHT + 0.02, posZ[i]);
      marker.visible = true;
      showDetails(i);
    }
  });

  // ---------- 9. RESET VIEW ----------
  document.getElementById("reset-view").addEventListener("click", () => {
    camera.position.set(centerX - spanDiag * 0.45, spanDiag * 0.55, centerZ + spanDiag * 0.45);
    controls.target.set(centerX, 0, centerZ);
    marker.visible = false;
    document.getElementById("details").style.display = "none";
  });

  // ---------- 9b. MINIMAP NAVIGATION ----------
  document.querySelectorAll(".mm-cell").forEach((el) => {
    el.addEventListener("click", () => {
      const letter = el.dataset.letter;
      const origin = cellOrigin.get(letter);
      if (!origin) return;
      const width = subsOf(letter).length * AISLE_PITCH;
      const cx = origin.x + width / 2;
      const cz = origin.z + origin.depth / 2;
      const dist = Math.max(width, origin.depth) * 1.1 + 15;
      controls.target.set(cx, 0, cz);
      camera.position.set(cx - dist * 0.4, dist * 0.5, cz + dist * 0.4);
      marker.visible = false;
      document.getElementById("details").style.display = "none";
    });
  });

  document.getElementById("toggle-panel").addEventListener("click", () => {
    const p = document.getElementById("panel");
    p.classList.toggle("collapsed");
  });

  // ---------- 10. RESIZE + RENDER LOOP ----------
  function resize() {
    const w = canvasHost.clientWidth, h = canvasHost.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  window.addEventListener("resize", resize);
  resize();

  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    if (marker.visible) marker.rotation.z += 0.02;
    renderer.render(scene, camera);
  }
  animate();

  applyFilters();

  const lastUpdateEl = document.getElementById("last-update");
  if (lastUpdateEl && META && META.generated_at) {
    lastUpdateEl.textContent = "Données du " + META.generated_at;
  }

  document.getElementById("loading").style.display = "none";
})();
