/* ============================================================
   WLAN-Mapper — Kernlogik
   Weltkoordinaten in Metern. Ansicht: view.x/y = Weltpunkt an
   der linken oberen Canvas-Ecke, view.pxPerM = Zoom.
   ============================================================ */
'use strict';

const LS_KEY = 'wlanmapper.v1';              // Alt-Format (Einzelprojekt) — wird migriert
const IDX_KEY = 'wlanmapper.index.v1';       // Projektliste { active, projects: [{id,name,updatedAt}] }
const PROJ_PREFIX = 'wlanmapper.proj.';      // ein Speicher-Slot pro Projekt
const AGENT_URL = 'http://localhost:3999/signal';
const SNAP = 0.05;              // Zeichen-Raster in m
const CLOSE_DIST_PX = 12;       // Klickdistanz zum Schließen des Polygons
const HIT_DIST_PX = 14;         // Trefferradius für Punkte
const HEAT_CELL = 0.15;         // Heatmap-Zellgröße in m
const HEAT_MAX_CELLS = 120000;

/* ---------- Zustand ---------- */
const DEFAULT_META = { kunde: '', objekt: '', techniker: '', datum: '', ssid: '', band: '5 GHz', notizen: '' };

const state = {
  meta: { ...DEFAULT_META },
  rooms: [],                    // [{ pts: [{x,y}, …] }]
  points: [],                   // [{ x, y, dbm, note }]
  bgImage: null,                // dataURL
  bgScale: 0.02,                // m pro Bild-Pixel
  bgOpacity: 0.6,
  heatOn: true,
  heatOpacity: 0.65,
  heatRange: 4,                 // m
};

const view = { x: -1.5, y: -1.5, pxPerM: 50 };
let mode = 'pan';
let bgImg = null;               // Image-Objekt zum dataURL
let drawing = null;             // aktuelles Raum-Polygon [{x,y}]
let calPts = [];                // Kalibrierungs-Klicks
let cursor = null;              // Weltposition der Maus
let panDrag = null;
let spaceDown = false;
let editIndex = -1;             // Index des Punkts im Dialog (-1 = neu)
let pendingPos = null;          // Weltposition für neuen Messpunkt
let lastAgent = null;           // { t, dbm, ssid }
const undoStack = [];

let heatCanvas = null, heatBounds = null, heatDirty = true;

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const canvas = $('mapCanvas');
const ctx = canvas.getContext('2d');
const mapArea = document.querySelector('.map-area');

/* ---------- Signal-Bewertung ---------- */
const HEAT_STOPS = [
  [-90, [142, 14, 0]], [-80, [224, 43, 32]], [-72, [255, 138, 0]],
  [-63, [255, 212, 0]], [-55, [122, 201, 67]], [-45, [0, 166, 81]],
];

function colorFor(dbm) {
  const s = HEAT_STOPS;
  if (dbm <= s[0][0]) return s[0][1];
  if (dbm >= s[s.length - 1][0]) return s[s.length - 1][1];
  for (let i = 0; i < s.length - 1; i++) {
    const [d0, c0] = s[i], [d1, c1] = s[i + 1];
    if (dbm >= d0 && dbm <= d1) {
      const t = (dbm - d0) / (d1 - d0);
      return [0, 1, 2].map(k => Math.round(c0[k] + (c1[k] - c0[k]) * t));
    }
  }
  return s[0][1];
}
const cssColor = (dbm) => `rgb(${colorFor(dbm).join(',')})`;

function qualityFor(dbm) {
  if (dbm >= -50) return 'sehr gut';
  if (dbm >= -60) return 'gut';
  if (dbm >= -67) return 'brauchbar';
  if (dbm >= -75) return 'mäßig';
  if (dbm >= -85) return 'schlecht';
  return 'sehr schlecht';
}
const fmtDbm = (dbm) => `−${Math.abs(Math.round(dbm))} dBm`;
const fmtM = (v) => v.toFixed(1).replace('.', ',');

/* ---------- Koordinaten ---------- */
const toScreen = (p, v = view) => ({ x: (p.x - v.x) * v.pxPerM, y: (p.y - v.y) * v.pxPerM });
const toWorld = (sx, sy, v = view) => ({ x: v.x + sx / v.pxPerM, y: v.y + sy / v.pxPerM });
const snap = (p) => ({ x: Math.round(p.x / SNAP) * SNAP, y: Math.round(p.y / SNAP) * SNAP });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function inPolygon(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > p.y) !== (b.y > p.y) &&
        p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function contentBounds() {
  let xs = [], ys = [];
  state.rooms.forEach(r => r.pts.forEach(p => { xs.push(p.x); ys.push(p.y); }));
  state.points.forEach(p => { xs.push(p.x); ys.push(p.y); });
  if (bgImg && state.bgImage) {
    xs.push(0, bgImg.naturalWidth * state.bgScale);
    ys.push(0, bgImg.naturalHeight * state.bgScale);
  }
  if (!xs.length) return { minX: 0, minY: 0, maxX: 12, maxY: 8 };
  return {
    minX: Math.min(...xs), minY: Math.min(...ys),
    maxX: Math.max(...xs), maxY: Math.max(...ys),
  };
}

/* ---------- Persistenz (Mehrprojekt) & Undo ---------- */
let saveTimer = null;
let storageWarned = false;
let projIndex = null;          // Projektliste, siehe IDX_KEY
let savingDisabled = false;    // Report-Ansicht mit ?src darf lokale Projekte nicht überschreiben

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 500);
}

function persistIndex() {
  try { localStorage.setItem(IDX_KEY, JSON.stringify(projIndex)); } catch (_) { /* Speicher voll */ }
}

function genId() {
  return 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e8).toString(36);
}

function saveNow() {
  if (savingDisabled || !projIndex) return;
  const entry = projIndex.projects.find(p => p.id === projIndex.active);
  if (entry) entry.updatedAt = Date.now();
  persistIndex();
  const key = PROJ_PREFIX + projIndex.active;
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch (e) {
    // Meist: Grundriss-Bild sprengt das Speicherlimit → ohne Bild sichern
    try {
      localStorage.setItem(key, JSON.stringify({ ...state, bgImage: null }));
      if (!storageWarned) {
        storageWarned = true;
        showHint('Grundriss-Bild ist zu groß für die automatische Speicherung — Projekt bitte zusätzlich als .json exportieren.', 5000);
      }
    } catch (_) { /* Speicher voll — Export bleibt möglich */ }
  }
}

function loadProject(id) {
  let raw = null;
  try { raw = localStorage.getItem(PROJ_PREFIX + id); } catch (_) { /* ignorieren */ }
  try { applyProject(raw ? JSON.parse(raw) : {}); }
  catch (_) { applyProject({}); }
}

function loadSaved() {
  try { projIndex = JSON.parse(localStorage.getItem(IDX_KEY) || 'null'); } catch (_) { projIndex = null; }

  if (!projIndex || !Array.isArray(projIndex.projects) || !projIndex.projects.length) {
    // Erststart oder Migration vom Alt-Format (ein Projekt unter LS_KEY)
    const id = genId();
    projIndex = { active: id, projects: [{ id, name: 'Projekt 1', updatedAt: Date.now() }] };
    let legacy = null;
    try { legacy = localStorage.getItem(LS_KEY); } catch (_) { /* ignorieren */ }
    if (legacy) {
      try {
        localStorage.setItem(PROJ_PREFIX + id, legacy);
        const kunde = (JSON.parse(legacy).meta || {}).kunde;
        if (kunde) projIndex.projects[0].name = kunde;
        // LS_KEY bewusst NICHT löschen — bleibt als Sicherung des Alt-Stands liegen
      } catch (_) { /* Migration fehlgeschlagen — leeres Projekt */ }
    }
    persistIndex();
  }
  adoptOrphanProjects();
  if (!projIndex.projects.some(p => p.id === projIndex.active)) {
    projIndex.active = projIndex.projects[0].id;
  }
  loadProject(projIndex.active);
}

// Projekt-Slots einsammeln, die nicht (mehr) im Index stehen — z. B. wenn zwei
// gleichzeitig geöffnete Tabs sich beim ersten Start den Index überschrieben haben.
function adoptOrphanProjects() {
  const known = new Set(projIndex.projects.map(p => p.id));
  const orphans = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PROJ_PREFIX)) {
        const id = k.slice(PROJ_PREFIX.length);
        if (!known.has(id)) orphans.push(id);
      }
    }
  } catch (_) { return; }
  if (!orphans.length) return;
  orphans.forEach((id, n) => {
    let name = `Wiederhergestellt ${n + 1}`;
    try {
      const kunde = (JSON.parse(localStorage.getItem(PROJ_PREFIX + id)).meta || {}).kunde;
      if (kunde) name = kunde;
    } catch (_) { /* Name bleibt generisch */ }
    projIndex.projects.push({ id, name, updatedAt: Date.now() });
  });
  persistIndex();
}

/* ---------- Projektverwaltung ---------- */
function refreshProjectUI() {
  const sel = $('projSelect');
  sel.innerHTML = '';
  projIndex.projects
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      opt.selected = p.id === projIndex.active;
      sel.appendChild(opt);
    });
  $('projCount').textContent = projIndex.projects.length;
}

function switchProject(id) {
  if (!id || id === projIndex.active) return;
  saveNow();
  projIndex.active = id;
  persistIndex();
  loadProject(id);
  refreshProjectUI();
  zoomFit();
  const entry = projIndex.projects.find(p => p.id === id);
  showHint(`Projekt „${entry ? entry.name : ''}“ geladen`);
}

function createProject(name) {
  const clean = (name || '').trim();
  if (!clean) return;
  saveNow();
  const id = genId();
  projIndex.projects.push({ id, name: clean, updatedAt: Date.now() });
  projIndex.active = id;
  persistIndex();
  applyProject({});
  refreshProjectUI();
  zoomFit();
  showHint(`Neues Projekt „${clean}“ angelegt`);
}

function renameActiveProject(name) {
  const clean = (name || '').trim();
  const entry = projIndex.projects.find(p => p.id === projIndex.active);
  if (!clean || !entry) return;
  entry.name = clean;
  persistIndex();
  refreshProjectUI();
}

function deleteActiveProject() {
  const entry = projIndex.projects.find(p => p.id === projIndex.active);
  if (!entry) return;
  try { localStorage.removeItem(PROJ_PREFIX + entry.id); } catch (_) { /* ignorieren */ }
  projIndex.projects = projIndex.projects.filter(p => p.id !== entry.id);
  if (!projIndex.projects.length) {
    const id = genId();
    projIndex.projects = [{ id, name: 'Projekt 1', updatedAt: Date.now() }];
  }
  projIndex.active = projIndex.projects[0].id;
  persistIndex();
  loadProject(projIndex.active);
  refreshProjectUI();
  zoomFit();
  showHint(`Projekt „${entry.name}“ gelöscht`);
}

function applyProject(data) {
  if (!data || typeof data !== 'object') throw new Error('Ungültiges Projektformat');
  undoStack.length = 0;   // Undo darf nicht über Projektgrenzen wirken
  state.meta = { ...DEFAULT_META, ...(data.meta || {}) };
  if (!state.meta.datum) state.meta.datum = new Date().toISOString().slice(0, 10);
  state.rooms = Array.isArray(data.rooms) ? data.rooms.filter(r => Array.isArray(r.pts) && r.pts.length >= 3) : [];
  state.points = Array.isArray(data.points)
    ? data.points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.dbm))
    : [];
  state.bgScale = Number.isFinite(data.bgScale) && data.bgScale > 0 ? data.bgScale : 0.02;
  state.bgOpacity = Number.isFinite(data.bgOpacity) ? data.bgOpacity : 0.6;
  state.heatOn = data.heatOn !== false;
  state.heatOpacity = Number.isFinite(data.heatOpacity) ? data.heatOpacity : 0.65;
  state.heatRange = Number.isFinite(data.heatRange) ? data.heatRange : 4;
  setBgImage(typeof data.bgImage === 'string' ? data.bgImage : null, false);
  heatDirty = true;
  syncFormFromState();
  refreshPointList();
  render();
  scheduleSave();
}

function pushUndo() {
  undoStack.push(JSON.stringify({ rooms: state.rooms, points: state.points, bgScale: state.bgScale }));
  if (undoStack.length > 50) undoStack.shift();
}

function undo() {
  // Während des Zeichnens: letzte Ecke entfernen statt kompletter Schritte
  if (drawing && drawing.length) {
    drawing.pop();
    if (!drawing.length) drawing = null;
    render();
    return;
  }
  const snapshot = undoStack.pop();
  if (!snapshot) { showHint('Nichts zum Rückgängigmachen'); return; }
  const s = JSON.parse(snapshot);
  state.rooms = s.rooms; state.points = s.points; state.bgScale = s.bgScale;
  heatDirty = true;
  refreshPointList(); render(); scheduleSave();
}

/* ---------- Grundriss-Bild ---------- */
function setBgImage(dataUrl, autoScale) {
  state.bgImage = dataUrl;
  bgImg = null;
  $('bgOpacityRow').hidden = !dataUrl;
  if (!dataUrl) { render(); return; }
  const img = new Image();
  img.onload = () => {
    bgImg = img;
    if (autoScale) {
      state.bgScale = 15 / img.naturalWidth;   // Startannahme: Bild ≈ 15 m breit
      zoomFit();
      showHint('Grundriss geladen — mit „Kalibrieren“ eine bekannte Strecke anklicken, um den Maßstab zu setzen.', 5000);
    }
    render(); scheduleSave();
  };
  img.src = dataUrl;
}

/* ---------- Heatmap ---------- */
function buildHeatmap() {
  heatDirty = false;
  if (!state.points.length) { heatCanvas = null; return; }

  const r = state.heatRange;
  let b;
  if (state.rooms.length) {
    b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    state.rooms.forEach(rm => rm.pts.forEach(p => {
      b.minX = Math.min(b.minX, p.x); b.minY = Math.min(b.minY, p.y);
      b.maxX = Math.max(b.maxX, p.x); b.maxY = Math.max(b.maxY, p.y);
    }));
  } else {
    b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    state.points.forEach(p => {
      b.minX = Math.min(b.minX, p.x - r); b.minY = Math.min(b.minY, p.y - r);
      b.maxX = Math.max(b.maxX, p.x + r); b.maxY = Math.max(b.maxY, p.y + r);
    });
  }
  b.minX -= 0.3; b.minY -= 0.3; b.maxX += 0.3; b.maxY += 0.3;

  const bw = b.maxX - b.minX, bh = b.maxY - b.minY;
  let cell = HEAT_CELL;
  while ((bw / cell) * (bh / cell) > HEAT_MAX_CELLS) cell *= 1.5;

  const w = Math.max(1, Math.ceil(bw / cell));
  const h = Math.max(1, Math.ceil(bh / cell));
  const cnv = document.createElement('canvas');
  cnv.width = w; cnv.height = h;
  const ictx = cnv.getContext('2d');
  const img = ictx.createImageData(w, h);
  const data = img.data;
  const pts = state.points;
  const clip = state.rooms.length > 0;

  for (let j = 0; j < h; j++) {
    const cy = b.minY + (j + 0.5) * cell;
    for (let i = 0; i < w; i++) {
      const cx = b.minX + (i + 0.5) * cell;
      const idx = (j * w + i) * 4;
      if (clip && !state.rooms.some(rm => inPolygon({ x: cx, y: cy }, rm.pts))) continue;

      let sw = 0, sv = 0, dMin = Infinity;
      for (const p of pts) {
        const d2 = (p.x - cx) ** 2 + (p.y - cy) ** 2;
        if (d2 < 1e-6) { sw = 1; sv = p.dbm; dMin = 0; break; }
        const wgt = 1 / d2;
        sw += wgt; sv += wgt * p.dbm;
        if (d2 < dMin * dMin || dMin === Infinity) dMin = Math.min(dMin, Math.sqrt(d2));
      }
      const val = sv / sw;
      let alpha = 1;
      if (dMin > r) {
        const fade = 1 - (dMin - r) / (r * 0.6);
        if (fade <= 0) continue;
        alpha = fade;
      }
      const c = colorFor(val);
      data[idx] = c[0]; data[idx + 1] = c[1]; data[idx + 2] = c[2];
      data[idx + 3] = Math.round(215 * alpha);
    }
  }
  ictx.putImageData(img, 0, 0);
  heatCanvas = cnv;
  heatBounds = b;
}

/* ---------- Rendering ---------- */

function renderScene(c, w, h, v, opts = {}) {
  c.fillStyle = '#f7f8f4';
  c.fillRect(0, 0, w, h);

  // Grundriss-Bild
  if (bgImg && state.bgImage) {
    c.globalAlpha = opts.export ? Math.max(state.bgOpacity, 0.5) : state.bgOpacity;
    const s = toScreen({ x: 0, y: 0 }, v);
    c.drawImage(bgImg, s.x, s.y, bgImg.naturalWidth * state.bgScale * v.pxPerM, bgImg.naturalHeight * state.bgScale * v.pxPerM);
    c.globalAlpha = 1;
  }

  // Meterraster
  const step = v.pxPerM;
  if (step >= 9) {
    const x0 = Math.floor(v.x), y0 = Math.floor(v.y);
    const cols = Math.ceil(w / step) + 1, rows = Math.ceil(h / step) + 1;
    for (let i = 0; i <= cols; i++) {
      const gx = x0 + i, sx = (gx - v.x) * step;
      c.strokeStyle = gx % 5 === 0 ? '#ccd2ca' : '#e4e7e0';
      c.beginPath(); c.moveTo(sx, 0); c.lineTo(sx, h); c.stroke();
    }
    for (let j = 0; j <= rows; j++) {
      const gy = y0 + j, sy = (gy - v.y) * step;
      c.strokeStyle = gy % 5 === 0 ? '#ccd2ca' : '#e4e7e0';
      c.beginPath(); c.moveTo(0, sy); c.lineTo(w, sy); c.stroke();
    }
  }

  // Räume dezent füllen (hebt sie vom Hintergrund/Grundriss-Foto ab)
  state.rooms.forEach(rm => {
    c.beginPath();
    rm.pts.forEach((p, i) => {
      const s = toScreen(p, v);
      i === 0 ? c.moveTo(s.x, s.y) : c.lineTo(s.x, s.y);
    });
    c.closePath();
    c.fillStyle = 'rgba(255,255,255,.45)';
    c.fill();
  });

  // Heatmap (in Räume geclippt, falls vorhanden)
  if (state.heatOn && heatCanvas) {
    c.save();
    if (state.rooms.length) {
      c.beginPath();
      state.rooms.forEach(rm => {
        rm.pts.forEach((p, i) => {
          const s = toScreen(p, v);
          i === 0 ? c.moveTo(s.x, s.y) : c.lineTo(s.x, s.y);
        });
        c.closePath();
      });
      c.clip();
    }
    c.globalAlpha = state.heatOpacity;
    c.imageSmoothingEnabled = true;
    const tl = toScreen({ x: heatBounds.minX, y: heatBounds.minY }, v);
    c.drawImage(heatCanvas, tl.x, tl.y,
      (heatBounds.maxX - heatBounds.minX) * v.pxPerM,
      (heatBounds.maxY - heatBounds.minY) * v.pxPerM);
    c.restore();
    c.globalAlpha = 1;
  }

  // Räume (Wände)
  c.lineJoin = 'round';
  state.rooms.forEach(rm => {
    c.beginPath();
    rm.pts.forEach((p, i) => {
      const s = toScreen(p, v);
      i === 0 ? c.moveTo(s.x, s.y) : c.lineTo(s.x, s.y);
    });
    c.closePath();
    c.strokeStyle = '#28313d';
    c.lineWidth = Math.max(2.5, v.pxPerM * 0.06);
    c.stroke();
  });

  // Zeichnungs-Vorschau
  if (!opts.export && drawing && drawing.length) {
    c.beginPath();
    drawing.forEach((p, i) => {
      const s = toScreen(p, v);
      i === 0 ? c.moveTo(s.x, s.y) : c.lineTo(s.x, s.y);
    });
    if (cursor) { const s = toScreen(snap(cursor), v); c.lineTo(s.x, s.y); }
    c.strokeStyle = '#0f6bff'; c.lineWidth = 2; c.setLineDash([6, 4]);
    c.stroke(); c.setLineDash([]);
    drawing.forEach((p, i) => {
      const s = toScreen(p, v);
      c.beginPath(); c.arc(s.x, s.y, i === 0 ? 6 : 4, 0, Math.PI * 2);
      c.fillStyle = i === 0 ? '#0f6bff' : '#fff';
      c.fill(); c.strokeStyle = '#0f6bff'; c.lineWidth = 2; c.stroke();
    });
    // Länge des aktuellen Wandsegments live anzeigen
    if (cursor) {
      const last = drawing[drawing.length - 1];
      const sc = snap(cursor);
      const segLen = dist(last, sc);
      if (segLen > 0.1) {
        const mid = toScreen({ x: (last.x + sc.x) / 2, y: (last.y + sc.y) / 2 }, v);
        c.font = '700 13px sans-serif';
        c.textAlign = 'center'; c.textBaseline = 'middle';
        const label = `${fmtM(segLen)} m`;
        c.strokeStyle = 'rgba(255,255,255,.9)'; c.lineWidth = 4;
        c.strokeText(label, mid.x, mid.y - 12);
        c.fillStyle = '#0a4fc0';
        c.fillText(label, mid.x, mid.y - 12);
      }
    }
  }

  // Kalibrierungs-Vorschau
  if (!opts.export && mode === 'calibrate' && calPts.length) {
    const a = toScreen(calPts[0], v);
    const end = calPts[1] || cursor;
    if (end) {
      const bpt = toScreen(end, v);
      c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(bpt.x, bpt.y);
      c.strokeStyle = '#e02b20'; c.lineWidth = 2; c.setLineDash([8, 5]); c.stroke(); c.setLineDash([]);
      [a, bpt].forEach(s => {
        c.beginPath(); c.arc(s.x, s.y, 5, 0, Math.PI * 2);
        c.fillStyle = '#e02b20'; c.fill();
      });
    }
  }

  // Messpunkte
  state.points.forEach((p, i) => {
    const s = toScreen(p, v);
    const r = opts.export ? Math.max(11, v.pxPerM * 0.22) : 11;
    c.beginPath(); c.arc(s.x, s.y, r, 0, Math.PI * 2);
    c.fillStyle = cssColor(p.dbm); c.fill();
    c.strokeStyle = '#fff'; c.lineWidth = 2.5; c.stroke();
    c.fillStyle = '#fff';
    c.font = `700 ${Math.round(r * 0.85)}px ${getComputedStyle(document.body).getPropertyValue('--mono') || 'monospace'}`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(String(i + 1), s.x, s.y + 0.5);
    // dBm-Label
    c.font = `600 ${Math.round(r * 0.95)}px ${getComputedStyle(document.body).getPropertyValue('--sans') || 'sans-serif'}`;
    c.fillStyle = '#28313d';
    c.strokeStyle = 'rgba(255,255,255,.85)'; c.lineWidth = 3;
    const label = `${Math.round(p.dbm)}`;
    c.strokeText(label, s.x, s.y + r + 9);
    c.fillText(label, s.x, s.y + r + 9);
  });
}

function render() {
  // Backing-Store bei Bedarf an die aktuelle Panelgröße anpassen
  const dpr = window.devicePixelRatio || 1;
  const w = mapArea.clientWidth, h = mapArea.clientHeight;
  if (w === 0 || h === 0) return;
  const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (heatDirty) buildHeatmap();
  renderScene(ctx, w, h, view);
  $('mapEmpty').hidden = !!(state.rooms.length || state.points.length || state.bgImage || drawing);
}

/* ---------- Ansicht ---------- */
function zoomAt(factor, sx, sy) {
  const before = toWorld(sx, sy);
  view.pxPerM = Math.min(400, Math.max(6, view.pxPerM * factor));
  const after = toWorld(sx, sy);
  view.x += before.x - after.x;
  view.y += before.y - after.y;
  updateStatus(); render();
}

function centerOn(p) {
  view.x = p.x - mapArea.clientWidth / (2 * view.pxPerM);
  view.y = p.y - mapArea.clientHeight / (2 * view.pxPerM);
  updateStatus(); render();
}

function zoomFit() {
  const b = contentBounds();
  const w = mapArea.clientWidth, h = mapArea.clientHeight;
  const pad = 1;
  const bw = b.maxX - b.minX + pad * 2, bh = b.maxY - b.minY + pad * 2;
  view.pxPerM = Math.min(400, Math.max(6, Math.min(w / bw, h / bh)));
  view.x = b.minX - pad - (w / view.pxPerM - bw) / 2;
  view.y = b.minY - pad - (h / view.pxPerM - bh) / 2;
  updateStatus(); render();
}

/* ---------- Modus & Status ---------- */
const MODE_LABEL = {
  pan: 'Bewegen', room: 'Raum zeichnen', measure: 'Messen',
  calibrate: 'Kalibrieren', erase: 'Löschen',
};
const MODE_HINT = {
  pan: 'Messpunkt antippen = bearbeiten · Messpunkt ziehen = verschieben',
  room: 'Klicken setzt Ecken · Doppelklick oder Klick auf den Startpunkt schließt den Raum · Esc bricht ab',
  measure: 'Auf die Position in der Karte klicken, an der gemessen wurde',
  calibrate: 'Zwei Punkte einer bekannten Strecke anklicken (z. B. eine Wand)',
  erase: 'Messpunkt oder Raum anklicken, um ihn zu entfernen',
};

function setMode(m) {
  if (drawing) drawing = null;
  calPts = [];
  mode = m;
  mapArea.dataset.mode = m;
  document.querySelectorAll('.tool[data-mode]').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === m));
  $('statusMode').textContent = `Modus: ${MODE_LABEL[m]}`;
  showHint(MODE_HINT[m] || '', MODE_HINT[m] ? 3500 : 0);
  render();
}

let hintTimer = null;
function showHint(text, ms = 2500) {
  const el = $('mapHint');
  if (!text) { el.classList.remove('show'); return; }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function updateStatus() {
  if (cursor) $('statusPos').textContent = `x ${fmtM(cursor.x)} m · y ${fmtM(cursor.y)} m`;
  $('statusZoom').textContent = `Zoom ${Math.round(view.pxPerM / 50 * 100)} %`;
  $('scaleLabel').textContent = `${Math.round(view.pxPerM)} px = 1 m`;
}

/* ---------- Interaktion ----------
   Touch-tauglich: Tippen führt die Modus-Aktion aus, Ein-Finger-Ziehen
   verschiebt die Karte (in jedem Modus), Zwei-Finger-Pinch zoomt.
   Für die Maus gilt dasselbe Modell (Klick = Tap, Ziehen = Verschieben). */
const pointers = new Map();
let pinch = null;           // { d0, pxPerM0, world0 }
let pointDrag = null;       // { idx, undoPushed } — Messpunkt verschieben
let gestureUsed = false;
const TAP_SLOP_PX = 8;

canvas.addEventListener('pointerdown', (e) => {
  try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* Pointer ggf. schon weg */ }
  pointers.set(e.pointerId, {
    x: e.offsetX, y: e.offsetY, sx: e.offsetX, sy: e.offsetY,
    button: e.button, type: e.pointerType, moved: false,
  });
  if (pointers.size === 1) {
    gestureUsed = false;
    pointDrag = null;
    if (mode === 'pan' && e.button === 0 && !spaceDown) {
      // Im Bewegen-Modus: Ziehen auf einem Messpunkt verschiebt ihn
      const hit = hitPoint(e.offsetX, e.offsetY, e.pointerType === 'touch' ? 22 : HIT_DIST_PX);
      if (hit >= 0) pointDrag = { idx: hit, undoPushed: false };
    }
    panDrag = { sx: e.offsetX, sy: e.offsetY, vx: view.x, vy: view.y };
  } else if (pointers.size === 2) {
    pointDrag = null;
    const [a, b] = [...pointers.values()];
    pinch = {
      d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)),
      pxPerM0: view.pxPerM,
      world0: toWorld((a.x + b.x) / 2, (a.y + b.y) / 2),
    };
    gestureUsed = true;
    panDrag = null;
  } else {
    pinch = null;
  }
});

canvas.addEventListener('pointermove', (e) => {
  cursor = toWorld(e.offsetX, e.offsetY);
  const p = pointers.get(e.pointerId);
  if (p) {
    p.x = e.offsetX; p.y = e.offsetY;
    if (!p.moved && Math.hypot(p.x - p.sx, p.y - p.sy) > TAP_SLOP_PX) p.moved = true;

    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const d = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      view.pxPerM = Math.min(400, Math.max(6, pinch.pxPerM0 * d / pinch.d0));
      view.x = pinch.world0.x - cx / view.pxPerM;
      view.y = pinch.world0.y - cy / view.pxPerM;
    } else if (pointDrag && p.moved && pointers.size === 1) {
      if (!pointDrag.undoPushed) { pushUndo(); pointDrag.undoPushed = true; }
      const w = snap(toWorld(p.x, p.y));
      state.points[pointDrag.idx].x = w.x;
      state.points[pointDrag.idx].y = w.y;
      // Heatmap live nur bei kleinen Projekten neu rechnen (sonst ruckelt das Ziehen);
      // bei großen Projekten folgt der Rebuild beim Loslassen
      heatDirty = state.points.length <= 25;
    } else if (panDrag && p.moved && pointers.size === 1) {
      view.x = panDrag.vx - (p.x - panDrag.sx) / view.pxPerM;
      view.y = panDrag.vy - (p.y - panDrag.sy) / view.pxPerM;
    }
  }
  updateStatus();
  if (p || drawing || (mode === 'calibrate' && calPts.length === 1)) render();
});

function endPointer(e) {
  const p = pointers.get(e.pointerId);
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 1) {
    // Verbleibenden Finger als neue Verschiebe-Basis nehmen (kein Sprung)
    const [rest] = [...pointers.values()];
    panDrag = { sx: rest.x, sy: rest.y, vx: view.x, vy: view.y };
  }
  if (pointers.size === 0) {
    const wasTap = p && !p.moved && !gestureUsed && p.button === 0
      && !spaceDown && e.type !== 'pointercancel';
    if (pointDrag && pointDrag.undoPushed) {
      heatDirty = true;          // finaler Heatmap-Rebuild nach dem Verschieben
      refreshPointList(); render(); scheduleSave();
    }
    pointDrag = null;
    panDrag = null;
    if (wasTap) handleTap(p.sx, p.sy, p.type);
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

function handleTap(sx, sy, pointerType) {
  const world = toWorld(sx, sy);
  const hitR = pointerType === 'touch' ? 22 : HIT_DIST_PX;

  if (mode === 'pan') {
    const hit = hitPoint(sx, sy, hitR);
    if (hit >= 0) openMeasureDialog(null, hit);
  } else if (mode === 'room') {
    const p = snap(world);
    if (drawing && drawing.length >= 3) {
      const first = toScreen(drawing[0]);
      if (Math.hypot(first.x - sx, first.y - sy) < Math.max(CLOSE_DIST_PX, hitR)) { closeRoom(); return; }
    }
    if (!drawing) drawing = [];
    drawing.push(p);
    render();
  } else if (mode === 'measure') {
    openMeasureDialog(world, -1);
  } else if (mode === 'calibrate') {
    if (calPts.length >= 2) calPts = [];
    calPts.push(world);
    if (calPts.length === 2) {
      const d = $('calibrateDialog');
      d.returnValue = '';
      d.showModal();
    }
    render();
  } else if (mode === 'erase') {
    eraseAt(sx, sy, world, hitR);
  }
}
canvas.addEventListener('dblclick', (e) => {
  e.preventDefault();
  if (mode === 'room' && drawing && drawing.length >= 3) closeRoom();
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.offsetX, e.offsetY);
}, { passive: false });

function closeRoom() {
  if (!drawing || drawing.length < 3) return;
  pushUndo();
  state.rooms.push({ pts: drawing });
  drawing = null;
  heatDirty = true;
  render(); scheduleSave();
  showHint('Raum angelegt — weiteren Raum zeichnen oder Werkzeug wechseln');
}

function hitPoint(sx, sy, r = HIT_DIST_PX) {
  for (let i = state.points.length - 1; i >= 0; i--) {
    const s = toScreen(state.points[i]);
    if (Math.hypot(s.x - sx, s.y - sy) < r) return i;
  }
  return -1;
}

function eraseAt(sx, sy, world, r = HIT_DIST_PX) {
  const pi = hitPoint(sx, sy, r);
  if (pi >= 0) {
    pushUndo();
    state.points.splice(pi, 1);
    heatDirty = true;
    refreshPointList(); render(); scheduleSave();
    return;
  }
  const ri = state.rooms.findIndex(rm => inPolygon(world, rm.pts));
  if (ri >= 0) {
    pushUndo();
    state.rooms.splice(ri, 1);
    heatDirty = true;
    render(); scheduleSave();
    showHint('Raum entfernt');
  }
}

/* ---------- Tastatur ---------- */
document.addEventListener('keydown', (e) => {
  // Strg/Cmd+P druckt immer den aufbereiteten Report statt der rohen Seite
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
    e.preventDefault();
    $('btnPdf').click();
    return;
  }
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.code === 'Space') { spaceDown = true; e.preventDefault(); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'z') { undo(); e.preventDefault(); return; }
  const keys = { v: 'pan', r: 'room', m: 'measure', k: 'calibrate', e: 'erase' };
  if (keys[e.key.toLowerCase()]) { setMode(keys[e.key.toLowerCase()]); return; }
  if (e.key === 'Escape') {
    if (drawing) { drawing = null; render(); }
    calPts = []; render();
  }
});
document.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceDown = false; });

/* ---------- Mess-Dialog ---------- */
const dlg = $('measureDialog');

function openMeasureDialog(worldPos, index) {
  editIndex = index;
  pendingPos = worldPos;
  const p = index >= 0 ? state.points[index] : null;
  $('dlgTitle').textContent = index >= 0 ? `Messpunkt ${index + 1} bearbeiten` : 'Neuer Messpunkt';
  $('dlgDbm').value = p ? p.dbm : (lastAgent && fresh(lastAgent) ? lastAgent.dbm : -65);
  $('dlgNote').value = p ? (p.note || '') : '';
  $('dlgAgent').hidden = !(lastAgent && fresh(lastAgent));
  updateDlgReadout();
  dlg.returnValue = '';
  dlg.showModal();
}

const fresh = (a) => Date.now() - a.t < 8000;

function updateDlgReadout() {
  const v = Number($('dlgDbm').value);
  $('dlgDbmOut').textContent = fmtDbm(v);
  const q = $('dlgQuality');
  q.textContent = qualityFor(v);
  q.style.background = cssColor(v);
}

$('dlgDbm').addEventListener('input', updateDlgReadout);
document.querySelectorAll('.dlg-presets button').forEach(b =>
  b.addEventListener('click', () => { $('dlgDbm').value = b.dataset.dbm; updateDlgReadout(); }));
$('dlgAgent').addEventListener('click', () => {
  if (lastAgent && fresh(lastAgent)) {
    $('dlgDbm').value = lastAgent.dbm;
    updateDlgReadout();
  } else {
    $('dlgAgent').hidden = true;   // Agent inzwischen weg — Button ausblenden
  }
});
$('dlgCancel').addEventListener('click', () => dlg.close('cancel'));

// Speichern am submit-Event (method="dialog" schließt den Dialog danach von selbst)
dlg.querySelector('form').addEventListener('submit', () => {
  const dbm = Number($('dlgDbm').value);
  const note = $('dlgNote').value.trim();
  pushUndo();
  if (editIndex >= 0) {
    state.points[editIndex] = { ...state.points[editIndex], dbm, note };
  } else if (pendingPos) {
    state.points.push({ x: pendingPos.x, y: pendingPos.y, dbm, note });
  }
  pendingPos = null;
  heatDirty = true;
  refreshPointList(); render(); scheduleSave();
});

/* ---------- Kalibrier-Dialog ---------- */
const calDlg = $('calibrateDialog');

function resetCalibration() {
  calPts = [];
  setMode('pan');
}

$('calCancel').addEventListener('click', () => { calDlg.close('cancel'); resetCalibration(); });
calDlg.addEventListener('cancel', resetCalibration);

calDlg.querySelector('form').addEventListener('submit', () => {
  let message = '';
  if (calPts.length === 2) {
    const real = Number($('calMeters').value);
    const measured = dist(calPts[0], calPts[1]);
    if (real > 0 && measured > 0.01) {
      if (bgImg && state.bgImage) {
        pushUndo();
        state.bgScale *= real / measured;
        heatDirty = true;
        message = `Maßstab gesetzt: Strecke = ${fmtM(real)} m`;
        scheduleSave();
      } else {
        message = 'Kalibrierung wirkt auf das Grundriss-Bild — bitte zuerst ein Bild laden. Beim Zeichnen gilt das Meterraster.';
      }
    }
  }
  resetCalibration();
  if (message) showHint(message, 4000);   // nach dem Moduswechsel, sonst wird sie überschrieben
});

/* ---------- Punktliste & Statistik ---------- */
function refreshPointList() {
  const list = $('pointList');
  $('pointCount').textContent = state.points.length;
  if (!state.points.length) {
    list.innerHTML = '<p class="hint empty-note">Noch keine Messpunkte. Werkzeug <strong>Messen</strong> wählen und auf die Karte klicken.</p>';
    $('statsBox').hidden = true;
    return;
  }
  list.innerHTML = '';
  state.points.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'point-row';
    row.innerHTML =
      `<span class="point-num" style="background:${cssColor(p.dbm)}">${i + 1}</span>` +
      `<span class="point-dbm">${fmtDbm(p.dbm)}</span>` +
      `<span class="point-note">${escapeHtml(p.note || qualityFor(p.dbm))}</span>` +
      `<button class="point-del" title="Löschen">✕</button>`;
    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('point-del')) {
        pushUndo();
        state.points.splice(i, 1);
        heatDirty = true;
        refreshPointList(); render(); scheduleSave();
      } else {
        centerOn(p);
        document.body.classList.remove('sidebar-open');
        openMeasureDialog(null, i);
      }
    });
    list.appendChild(row);
  });

  const st = pointStats();
  $('statsBox').hidden = false;
  $('statMin').textContent = fmtDbm(st.min);
  $('statAvg').textContent = fmtDbm(st.avg);
  $('statMax').textContent = fmtDbm(st.max);
  $('statMin').style.color = cssColor(st.min);
  $('statMax').style.color = cssColor(st.max);
}

function pointStats() {
  const vals = state.points.map(p => p.dbm);
  return {
    min: Math.min(...vals),
    max: Math.max(...vals),
    avg: vals.reduce((a, b) => a + b, 0) / vals.length,
    minIndex: vals.indexOf(Math.min(...vals)),
  };
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/* ---------- Formular-Bindung ---------- */
const META_FIELDS = [
  ['mKunde', 'kunde'], ['mObjekt', 'objekt'], ['mTechniker', 'techniker'],
  ['mDatum', 'datum'], ['mSsid', 'ssid'], ['mBand', 'band'], ['mNotizen', 'notizen'],
];

function syncFormFromState() {
  META_FIELDS.forEach(([id, key]) => { $(id).value = state.meta[key] || ($(id).tagName === 'SELECT' ? '5 GHz' : ''); });
  $('bgOpacity').value = Math.round(state.bgOpacity * 100);
  $('heatToggle').checked = state.heatOn;
  $('heatOpacity').value = Math.round(state.heatOpacity * 100);
  $('heatRange').value = state.heatRange;
  $('rangeLabel').textContent = `${state.heatRange} m`;
  $('mapLegend').hidden = !state.heatOn;
}

META_FIELDS.forEach(([id, key]) => {
  $(id).addEventListener('input', () => { state.meta[key] = $(id).value; scheduleSave(); });
});

$('bgUpload').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { pushUndo(); loadScaledImage(reader.result); };
  reader.onerror = () => showHint('Bild konnte nicht gelesen werden');
  reader.readAsDataURL(file);
  e.target.value = '';
});

// Große Fotos (Handy-Kamera) vor dem Speichern verkleinern — schont
// localStorage-Limit und Render-Performance, Grundriss bleibt gut lesbar
const BG_MAX_EDGE = 2000;

function loadScaledImage(dataUrl) {
  const img = new Image();
  img.onload = () => {
    const edge = Math.max(img.naturalWidth, img.naturalHeight);
    if (edge <= BG_MAX_EDGE) { setBgImage(dataUrl, true); return; }
    const f = BG_MAX_EDGE / edge;
    const cnv = document.createElement('canvas');
    cnv.width = Math.round(img.naturalWidth * f);
    cnv.height = Math.round(img.naturalHeight * f);
    cnv.getContext('2d').drawImage(img, 0, 0, cnv.width, cnv.height);
    setBgImage(cnv.toDataURL('image/jpeg', 0.85), true);
  };
  img.onerror = () => showHint('Bild konnte nicht gelesen werden — bitte PNG oder JPG verwenden');
  img.src = dataUrl;
}
$('bgOpacity').addEventListener('input', (e) => { state.bgOpacity = e.target.value / 100; render(); scheduleSave(); });
$('heatToggle').addEventListener('change', (e) => {
  state.heatOn = e.target.checked;
  $('mapLegend').hidden = !state.heatOn;
  render(); scheduleSave();
});
$('heatOpacity').addEventListener('input', (e) => { state.heatOpacity = e.target.value / 100; render(); scheduleSave(); });
$('heatRange').addEventListener('input', (e) => {
  state.heatRange = Number(e.target.value);
  $('rangeLabel').textContent = `${state.heatRange} m`;
  heatDirty = true; render(); scheduleSave();
});
$('btnClearRooms').addEventListener('click', () => {
  if (!state.rooms.length || !confirm('Alle gezeichneten Räume entfernen?')) return;
  pushUndo();
  state.rooms = [];
  heatDirty = true;
  render(); scheduleSave();
});

/* ---------- Werkzeugleiste ---------- */
document.querySelectorAll('.tool[data-mode]').forEach(b =>
  b.addEventListener('click', () => setMode(b.dataset.mode)));
$('btnSidebar').addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
$('sidebarOverlay').addEventListener('click', () => document.body.classList.remove('sidebar-open'));

/* ---------- Projekt-UI ---------- */
// window.prompt() existiert nicht überall (z. B. Electron) — eigener Namensdialog.
let nameResolve = null;

function askName(title, initial) {
  return new Promise((resolve) => {
    nameResolve = resolve;
    $('nameDlgTitle').textContent = title;
    $('nameDlgInput').value = initial || '';
    const d = $('nameDialog');
    d.returnValue = '';
    d.showModal();
    $('nameDlgInput').select();
  });
}

function resolveName(value) {
  if (nameResolve) { nameResolve(value); nameResolve = null; }
}

$('nameDialog').querySelector('form').addEventListener('submit', () => {
  resolveName($('nameDlgInput').value.trim() || null);
});
$('nameDlgCancel').addEventListener('click', () => {
  $('nameDialog').close();
  resolveName(null);
});
$('nameDialog').addEventListener('cancel', () => resolveName(null));   // Esc

$('projSelect').addEventListener('change', (e) => switchProject(e.target.value));
$('projNew').addEventListener('click', async () => {
  const name = await askName('Neues Projekt anlegen', '');
  if (name) createProject(name);
});
$('projRename').addEventListener('click', async () => {
  const entry = projIndex.projects.find(p => p.id === projIndex.active);
  const name = await askName('Projekt umbenennen', entry ? entry.name : '');
  if (name) renameActiveProject(name);
});
$('projDelete').addEventListener('click', () => {
  const entry = projIndex.projects.find(p => p.id === projIndex.active);
  if (!entry) return;
  if (confirm(`Projekt „${entry.name}“ mit allen Messungen endgültig löschen?`)) deleteActiveProject();
});
$('btnUndo').addEventListener('click', undo);
$('btnZoomIn').addEventListener('click', () => zoomAt(1.25, mapArea.clientWidth / 2, mapArea.clientHeight / 2));
$('btnZoomOut').addEventListener('click', () => zoomAt(1 / 1.25, mapArea.clientWidth / 2, mapArea.clientHeight / 2));
$('btnZoomFit').addEventListener('click', zoomFit);

/* ---------- Signal-Agent (optional, signal-agent.ps1) ---------- */
async function pollAgent() {
  if (document.hidden) return;   // im Hintergrund nicht pollen (Akku, Funkruhe)
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 1500);
    const res = await fetch(AGENT_URL, { signal: ac.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    if (Number.isFinite(data.dbm)) {
      lastAgent = { t: Date.now(), dbm: Math.round(data.dbm), ssid: data.ssid || '' };
      $('agentDot').classList.add('on');
      $('agentLabel').textContent = `Agent: ${fmtDbm(lastAgent.dbm)}${lastAgent.ssid ? ' · ' + lastAgent.ssid : ''}`;
      if (!dlg.open) return;
      $('dlgAgent').hidden = false;
    }
  } catch (_) {
    $('agentDot').classList.remove('on');
    $('agentLabel').textContent = 'Agent aus';
  }
}
setInterval(pollAgent, 4000);
pollAgent();

/* ---------- Start ---------- */
window.addEventListener('resize', render);
window.addEventListener('orientationchange', () => setTimeout(render, 150));
new ResizeObserver(() => render()).observe(mapArea);
// Fallback für Umgebungen, in denen ResizeObserver nicht zuverlässig feuert:
// Backing-Store-Größe regelmäßig gegen die Panelgröße prüfen (billig, nur bei Abweichung neu zeichnen)
setInterval(() => {
  const dpr = window.devicePixelRatio || 1;
  if (mapArea.clientWidth > 0 && canvas.width !== Math.round(mapArea.clientWidth * dpr)) render();
}, 500);

loadSaved();
refreshProjectUI();
syncFormFromState();
refreshPointList();
setMode('pan');
zoomFit();

/* ---------- Rundgang-Ergebnis übernehmen (walk.js) ---------- */
function commitWalk(roomPts, walkPoints) {
  pushUndo();
  state.rooms.push({ pts: roomPts });
  walkPoints.forEach(p => state.points.push(p));
  heatDirty = true;
  refreshPointList(); render(); scheduleSave();
  zoomFit();
}

/* ---------- Export-Schnittstelle für report.js / walk.js ---------- */
window.WM = {
  state, view, renderScene, contentBounds, pointStats,
  cssColor, qualityFor, fmtDbm, fmtM, applyProject, showHint,
  commitWalk, saveNow,
  get bgImg() { return bgImg; },
  rebuildHeat() { heatDirty = true; buildHeatmap(); },
  setSavingDisabled(v) { savingDisabled = !!v; },
  agentValue() { return lastAgent && fresh(lastAgent) ? lastAgent : null; },
  hasContent() { return !!(state.rooms.length || state.points.length || state.bgImage); },
  projects: {
    create: createProject,
    switchTo: switchProject,
    rename: renameActiveProject,
    remove: deleteActiveProject,
    index: () => projIndex,
  },
};
