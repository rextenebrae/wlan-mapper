/* ============================================================
   WLAN-Mapper Server (Node, ohne Abhängigkeiten)
   - liefert die App im lokalen Netz aus (Handy → PC-IP:3630)
   - nimmt Messdaten entgegen (POST /api/report) und speichert sie
   - erzeugt daraus serverseitig ein PDF (Headless Edge/Chrome)

   Start:  node server.mjs          (Port 3630, alle Interfaces)
   ============================================================ */
import http from 'node:http';
import { promises as fs, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3630);
const DATA_DIR = path.join(ROOT, 'data');
const REPORTS_DIR = path.join(ROOT, 'reports');
const MAX_BODY = 20 * 1024 * 1024;

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(REPORTS_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
};

const BROWSER_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function findBrowser() {
  return BROWSER_PATHS.find(existsSync) || null;
}

function newId() {
  const t = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${t}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

const SAFE_ID = /^[\w-]+$/;

// Der Edge/Chrome-Launcher kann sich beenden, bevor der delegierte Prozess das
// PDF fertig geschrieben hat — deshalb auf Existenz + stabile Dateigröße warten.
async function waitForFile(filePath, timeoutMs = 45000) {
  const t0 = Date.now();
  let lastSize = -1;
  while (Date.now() - t0 < timeoutMs) {
    if (existsSync(filePath)) {
      const size = (await fs.stat(filePath)).size;
      if (size > 0 && size === lastSize) return true;
      lastSize = size;
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

async function makePdf(id) {
  const browser = findBrowser();
  if (!browser) throw new Error('Kein Edge/Chrome für die PDF-Erzeugung gefunden');
  const pdfPath = path.join(REPORTS_DIR, `${id}.pdf`);
  const url = `http://localhost:${PORT}/?report=1&nosw=1&src=/api/data/${id}`;

  await new Promise((resolve, reject) => {
    execFile(browser, [
      '--headless',
      '--disable-gpu',
      '--no-first-run',
      '--disable-extensions',
      `--user-data-dir=${path.join(os.tmpdir(), 'wlanmapper-pdf-profile')}`,
      '--virtual-time-budget=10000',
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`,
      url,
    ], { timeout: 90000 }, (err) => err ? reject(new Error(`PDF-Renderer fehlgeschlagen: ${err.message}`)) : resolve());
  });

  if (!(await waitForFile(pdfPath))) throw new Error('PDF wurde nicht erzeugt');
  return pdfPath;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Anfrage zu groß')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(body);
}

async function sendFile(res, filePath) {
  try {
    const bytes = await fs.readFile(filePath);
    const mime = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': bytes.length, 'Cache-Control': 'no-cache' });
    res.end(bytes);
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    if (p === '/api/ping') { sendJson(res, 200, { ok: true, name: 'wlan-mapper' }); return; }

    if (p === '/api/report' && req.method === 'POST') {
      const raw = await readBody(req);
      let project;
      try { project = JSON.parse(raw); } catch (_) { sendJson(res, 400, { ok: false, error: 'Ungültiges JSON' }); return; }
      if (!project || typeof project !== 'object') { sendJson(res, 400, { ok: false, error: 'Ungültige Projektdaten' }); return; }

      const id = newId();
      await fs.writeFile(path.join(DATA_DIR, `${id}.json`), JSON.stringify(project, null, 2), 'utf8');
      console.log(`[${new Date().toLocaleTimeString('de-DE')}] Messdaten gespeichert: ${id} (Kunde: ${(project.meta || {}).kunde || '—'})`);

      await makePdf(id);
      console.log(`[${new Date().toLocaleTimeString('de-DE')}] PDF erzeugt: reports/${id}.pdf`);
      sendJson(res, 200, { ok: true, id, pdf: `/reports/${id}.pdf`, data: `/api/data/${id}` });
      return;
    }

    if (p.startsWith('/api/data/')) {
      const id = p.slice('/api/data/'.length);
      if (!SAFE_ID.test(id)) { sendJson(res, 400, { ok: false, error: 'Ungültige ID' }); return; }
      await sendFile(res, path.join(DATA_DIR, `${id}.json`));
      return;
    }

    if (p.startsWith('/reports/')) {
      const name = path.basename(p);
      if (!SAFE_ID.test(name.replace(/\.pdf$/, ''))) { res.writeHead(400); res.end(); return; }
      await sendFile(res, path.join(REPORTS_DIR, name));
      return;
    }

    // Statische App-Dateien
    let rel = p === '/' ? 'index.html' : decodeURIComponent(p.slice(1));
    const filePath = path.normalize(path.join(ROOT, rel));
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    await sendFile(res, filePath);
  } catch (e) {
    console.error('Fehler:', e.message);
    sendJson(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const lan = Object.values(nets).flat().find(n => n && n.family === 'IPv4' && !n.internal);
  console.log(`WLAN-Mapper Server läuft:`);
  console.log(`  PC:     http://localhost:${PORT}`);
  if (lan) console.log(`  Handy:  http://${lan.address}:${PORT}   (gleiches WLAN, Firewall ggf. freigeben)`);
  console.log(`  PDF-Renderer: ${findBrowser() || 'NICHT GEFUNDEN (Edge/Chrome nötig)'}`);
});
