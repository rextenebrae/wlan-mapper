/* ============================================================
   WLAN-Mapper — PDF-Report, Projekt-Export/-Import, Server-PDF
   Der lokale PDF-Export rendert die Karte in ein Bild und öffnet
   den Druckdialog (dort „Als PDF speichern" wählen).
   Mit ?report=1[&src=URL] baut sich der Report automatisch auf —
   das nutzt der Server für die Headless-PDF-Erzeugung.
   ============================================================ */
'use strict';

(function () {
  const WM = window.WM;
  const $ = (id) => document.getElementById(id);

  /* ---------- Karten-Snapshot ---------- */
  function mapSnapshot() {
    const b = WM.contentBounds();
    const pad = 0.8;
    const bw = b.maxX - b.minX + pad * 2;
    const bh = b.maxY - b.minY + pad * 2;
    const pxPerM = Math.min(160, Math.max(25, 1600 / bw));
    const w = Math.round(bw * pxPerM);
    const h = Math.round(bh * pxPerM);

    const cnv = document.createElement('canvas');
    cnv.width = Math.min(w, 3000);
    cnv.height = Math.min(h, 3000);
    const scale = Math.min(cnv.width / w, cnv.height / h);
    const view = { x: b.minX - pad, y: b.minY - pad, pxPerM: pxPerM * scale };

    WM.rebuildHeat();
    WM.renderScene(cnv.getContext('2d'), cnv.width, cnv.height, view, { export: true });
    return cnv.toDataURL('image/png');
  }

  /* ---------- Automatische Bewertung mit Ortsangabe & Empfehlungen ---------- */
  function areaLabel(p) {
    const b = WM.contentBounds();
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    const dx = p.x - cx, dy = p.y - cy;
    const horiz = Math.abs(dx) < (b.maxX - b.minX) * 0.15 ? '' : (dx < 0 ? 'linken' : 'rechten');
    const vert = Math.abs(dy) < (b.maxY - b.minY) * 0.15 ? '' : (dy < 0 ? 'oberen' : 'unteren');
    const part = [vert, horiz].filter(Boolean).join(' ');
    return part ? `im ${part} Bereich der Karte` : 'im mittleren Bereich der Karte';
  }

  function autoRecommendation() {
    const pts = WM.state.points;
    if (!pts.length) return 'Keine Messpunkte erfasst.';
    const st = WM.pointStats();
    const lines = [];

    if (st.avg >= -55) {
      lines.push('Gesamtbewertung: Die WLAN-Versorgung im ausgemessenen Bereich ist sehr gut.');
    } else if (st.avg >= -65) {
      lines.push('Gesamtbewertung: Die WLAN-Versorgung im ausgemessenen Bereich ist gut.');
    } else if (st.avg >= -72) {
      lines.push('Gesamtbewertung: Die WLAN-Versorgung ist im Durchschnitt nur brauchbar — für latenzkritische Anwendungen (VoIP, Kassensysteme, Video) sollte nachgebessert werden.');
    } else {
      lines.push('Gesamtbewertung: Die WLAN-Versorgung ist im Durchschnitt unzureichend.');
    }

    const weak = pts
      .map((p, i) => ({ ...p, nr: i + 1 }))
      .filter(p => p.dbm <= -75)
      .sort((a, b) => a.dbm - b.dbm);

    if (weak.length) {
      const list = weak.slice(0, 4).map(p => `Nr. ${p.nr} (${WM.fmtDbm(p.dbm)}, ${areaLabel(p)})`).join('; ');
      lines.push(`Problemzonen: Unterversorgung bei Messpunkt ${list}.`);
      lines.push('Mögliche Ursachen: zu große Entfernung zum Access Point, dämpfende Bausubstanz (Stahlbeton, Metalltüren, Regale/Inventar — siehe Anmerkungen der Messpunkte) oder Funkschatten durch Einbauten.');
      lines.push('Empfehlung: 1) Access Point zentraler bzw. höher positionieren. 2) Für die Problemzonen einen zusätzlichen Access Point oder Mesh-Repeater vorsehen. 3) Bei dichter Bebauung 5-GHz-Betrieb mit ausreichender Zellenüberlappung planen; 2,4 GHz nur für Reichweite. 4) Nach der Maßnahme Kontrollmessung durchführen.');
    } else if (st.min <= -67) {
      lines.push('Einzelne Randbereiche liegen im mäßigen Bereich, für Standardanwendungen aber ausreichend. Bei Bedarf Ausrichtung/Position des Access Points optimieren.');
    } else {
      lines.push('Keine Problemzonen festgestellt — keine Maßnahmen erforderlich.');
    }
    return lines.join('\n');
  }

  /* ---------- Report befüllen ---------- */
  async function buildReport() {
    const m = WM.state.meta;
    const setText = (id, v, fallback = '—') => { $(id).textContent = v && String(v).trim() ? v : fallback; };

    setText('repKunde', m.kunde);
    setText('repObjekt', m.objekt, '');
    setText('repObjekt2', m.objekt);
    setText('repTechniker', m.techniker);
    setText('repSsid', m.ssid);
    setText('repBand', m.band);
    setText('repDatum', m.datum ? new Date(m.datum + 'T00:00:00').toLocaleDateString('de-DE') : '—');
    $('repStamp').textContent = new Date().toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
    $('repReco').textContent = m.notizen && m.notizen.trim() ? m.notizen : autoRecommendation();

    const statsBox = $('repStats');
    if (WM.state.points.length) {
      const st = WM.pointStats();
      statsBox.innerHTML =
        `<div class="rstat"><b style="color:${WM.cssColor(st.min)}">${WM.fmtDbm(st.min)}</b><span>schwächster Punkt</span></div>` +
        `<div class="rstat"><b>${WM.fmtDbm(st.avg)}</b><span>Durchschnitt</span></div>` +
        `<div class="rstat"><b style="color:${WM.cssColor(st.max)}">${WM.fmtDbm(st.max)}</b><span>stärkster Punkt</span></div>` +
        `<div class="rstat"><b>${WM.state.points.length}</b><span>Messpunkte</span></div>`;
    } else {
      statsBox.innerHTML = '';
    }

    const tbody = $('repPoints').querySelector('tbody');
    tbody.innerHTML = '';
    WM.state.points.forEach((p, i) => {
      const tr = document.createElement('tr');
      const td = (html) => { const el = document.createElement('td'); el.innerHTML = html; return el; };
      tr.appendChild(td(`<span class="p-badge" style="background:${WM.cssColor(p.dbm)}">${i + 1}</span>`));
      tr.appendChild(td(`<span class="mono">${WM.fmtM(p.x)} m / ${WM.fmtM(p.y)} m</span>`));
      tr.appendChild(td(`<span class="mono">${WM.fmtDbm(p.dbm)}</span>`));
      tr.appendChild(td(WM.qualityFor(p.dbm)));
      const noteTd = document.createElement('td');
      noteTd.textContent = p.note || '';
      tr.appendChild(noteTd);
      tbody.appendChild(tr);
    });

    const img = $('repMapImg');
    img.src = mapSnapshot();
    try { await img.decode(); } catch (_) { /* weiter ohne decode */ }
  }

  /* ---------- Lokaler PDF-Export über den Druckdialog ---------- */
  async function exportPdf() {
    await buildReport();
    // Der Seitentitel wird zum PDF-Dateinamen im Druckdialog
    const m = WM.state.meta;
    const oldTitle = document.title;
    const slug = (s) => (s || '').trim().replace(/[^\wäöüÄÖÜß-]+/g, '-').replace(/^-+|-+$/g, '');
    document.title = ['WLAN-Report', slug(m.kunde), m.datum].filter(Boolean).join('_');
    window.print();
    document.title = oldTitle;
  }

  $('btnPdf').addEventListener('click', () => {
    if (!WM.state.points.length && !WM.state.rooms.length) {
      WM.showHint('Für den Report bitte zuerst einen Rundgang machen oder Messpunkte setzen.');
      return;
    }
    exportPdf();
  });

  /* ---------- Automatik-Modus für Headless-PDF (Server) ---------- */
  const params = new URLSearchParams(location.search);
  if (params.has('report')) {
    (async () => {
      const src = params.get('src');
      if (src && src.startsWith('/')) {
        WM.setSavingDisabled(true);   // fremde Daten nie in lokale Projekte schreiben
        try {
          const res = await fetch(src);
          if (res.ok) WM.applyProject(await res.json());
        } catch (_) { /* Report bleibt leer, Fehler sichtbar im PDF */ }
      }
      await new Promise(r => setTimeout(r, 300));
      await buildReport();
      document.title = 'REPORT_READY';
    })();
  }

  /* ---------- Server-PDF (wenn die App vom Node-Server kommt) ---------- */
  const serverBtn = $('btnServerPdf');
  fetch('api/ping').then(r => { if (r.ok) serverBtn.hidden = false; }).catch(() => { /* kein Server */ });

  serverBtn.addEventListener('click', async () => {
    if (!WM.state.points.length && !WM.state.rooms.length) {
      WM.showHint('Für den Report bitte zuerst einen Rundgang machen oder Messpunkte setzen.');
      return;
    }
    serverBtn.disabled = true;
    const oldLabel = serverBtn.textContent;
    serverBtn.textContent = 'PDF wird auf dem Server erzeugt …';
    try {
      const res = await fetch('api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(WM.state),
      });
      const out = await res.json();
      if (!res.ok || !out.ok) throw new Error(out.error || `Serverfehler (${res.status})`);
      WM.showHint('PDF erzeugt — Download startet.', 4000);
      window.open(out.pdf, '_blank');
    } catch (e) {
      WM.showHint(`PDF-Erzeugung fehlgeschlagen: ${e.message}`, 5000);
    }
    serverBtn.disabled = false;
    serverBtn.textContent = oldLabel;
  });

  /* ---------- Projekt-Export / -Import ---------- */
  $('btnExportJson').addEventListener('click', () => {
    const name = (WM.state.meta.kunde || 'projekt').toLowerCase().replace(/[^a-z0-9äöüß]+/gi, '-');
    const blob = new Blob([JSON.stringify(WM.state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `wlan-mapper_${name}_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $('importJson').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        WM.applyProject(JSON.parse(reader.result));
        WM.showHint('Projekt in das aktive Projekt geladen');
      } catch (_) {
        WM.showHint('Datei konnte nicht gelesen werden — kein gültiges WLAN-Mapper-Projekt.');
      }
    };
    reader.onerror = () => WM.showHint('Datei konnte nicht gelesen werden');
    reader.readAsText(file);
    e.target.value = '';
  });

  $('btnReset').addEventListener('click', () => {
    if (!confirm('Aktives Projekt wirklich leeren? Grundriss, Messpunkte und Projektdaten gehen verloren.')) return;
    WM.applyProject({});
    WM.showHint('Projekt geleert');
  });
})();
