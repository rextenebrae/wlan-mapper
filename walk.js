/* ============================================================
   WLAN-Mapper — Rundgang-Messung
   Geführter Ablauf ohne Grundriss-Foto: Der Techniker geht im
   Uhrzeigersinn an der Wand entlang. Das Gerät signalisiert per
   Vibration/Ton, wann er stehen bleiben soll, misst automatisch
   (Signal-Agent, sonst Netz-Probe zum Server) und verteilt die
   Messpunkte gleichmäßig auf dem Umfang eines L×B-Rechtecks.
   ============================================================ */
'use strict';

(function () {
  const WM = window.WM;
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const SETTLE_MS = 900;        // Ruhe vor der Messung nach dem Stehenbleiben
  const PROBE_SAMPLES = 4;

  let run = null;               // { opts, measures[], stopFlag, wakeLock }

  /* ---------- Signale: Vibration + Ton + Anzeige ---------- */
  let audioCtx = null;

  function beep(times) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      for (let i = 0; i < times; i++) {
        const t = audioCtx.currentTime + i * 0.25;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.25, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(t); osc.stop(t + 0.2);
      }
    } catch (_) { /* Audio nicht verfügbar */ }
  }

  function buzz(pattern, beeps) {
    if (navigator.vibrate) navigator.vibrate(pattern);   // Android; iOS kann nicht vibrieren
    if (run && run.opts.sound) beep(beeps);
  }

  /* ---------- Automatische Messung ---------- */
  // Netz-Probe: mittlere Antwortzeit kleiner Anfragen an den eigenen Server.
  // Auf der WLAN-Strecke korreliert das mit der Verbindungsqualität am Standort.
  async function probeRtt() {
    const rtts = [];
    for (let i = 0; i < PROBE_SAMPLES; i++) {
      const t0 = performance.now();
      try {
        await fetch(`manifest.webmanifest?probe=${Date.now()}_${i}`, { cache: 'no-store' });
        rtts.push(performance.now() - t0);
      } catch (_) {
        rtts.push(600);   // Anfrage verloren = sehr schlechte Verbindung
      }
    }
    rtts.sort((a, b) => a - b);
    return {
      rtt: Math.round(rtts[1]),                          // ~Median (2. von 4)
      jitter: Math.round(rtts[rtts.length - 1] - rtts[0]),
    };
  }

  // RTT+Jitter auf die dBm-Skala der Heatmap abbilden (2 ms ≈ −35, 600 ms ≈ −80)
  function rttToDbm(rtt, jitter) {
    const eff = Math.min(600, Math.max(2, rtt + jitter * 0.3));
    return Math.round(-35 - 18 * Math.log10(eff / 2));
  }

  async function takeMeasure() {
    const agent = WM.agentValue();
    if (agent) {
      return { dbm: agent.dbm, note: 'Rundgang · Agent' };
    }
    const { rtt, jitter } = await probeRtt();
    return { dbm: rttToDbm(rtt, jitter), note: `Rundgang · Netz-Probe ${rtt} ms` };
  }

  /* ---------- Ablaufsteuerung ---------- */
  function setPhase(kind, title, sub) {
    const overlay = $('walkOverlay');
    overlay.classList.toggle('measuring', kind === 'mess');
    overlay.classList.toggle('walking', kind === 'geh');
    $('walkPhase').textContent = title;
    $('walkSub').textContent = sub;
  }

  function noteMeasure(m) {
    run.measures.push(m);
    $('walkCount').textContent = `${run.measures.length} Messung${run.measures.length === 1 ? '' : 'en'} · zuletzt ${WM.fmtDbm(m.dbm)}`;
  }

  // Modus „Automatisch“: feste Gehzeit, Signale sagen Stopp/Weiter
  async function loop() {
    while (run && !run.stopFlag) {
      setPhase('mess', 'STOPP', 'Stehen bleiben — Messung läuft …');
      await sleep(SETTLE_MS);
      if (!run || run.stopFlag) return;
      const m = await takeMeasure();
      if (!run || run.stopFlag) return;
      noteMeasure(m);

      buzz([120, 90, 120], 2);
      setPhase('geh', 'GEHEN →', 'Im Uhrzeigersinn an der Wand entlang · am Startpunkt „Fertig“ tippen');
      const until = performance.now() + run.opts.interval * 1000;
      while (run && !run.stopFlag && performance.now() < until) await sleep(100);
      if (!run || run.stopFlag) return;
      buzz([450], 1);
    }
  }

  // Modus „Per Tipp“: der Techniker löst jede Messung selbst aus
  let tapBusy = false;

  async function tapMeasure() {
    if (!run || tapBusy) return;
    tapBusy = true;
    const btn = $('walkMeasure');
    btn.disabled = true;
    setPhase('mess', 'MESSUNG', 'Kurz still halten …');
    const m = await takeMeasure();
    if (run && !run.stopFlag) {
      noteMeasure(m);
      buzz([120], 1);
      setPhase('geh', 'GEHEN →', 'Im Uhrzeigersinn zum nächsten Messort · dort wieder „Messen“ tippen');
    }
    btn.disabled = false;
    tapBusy = false;
  }

  $('walkMeasure').addEventListener('click', tapMeasure);

  /* ---------- Geometrie: Messungen auf den Raumumfang legen ---------- */
  // Uhrzeigersinn ab „oben links“: oben → rechts → unten → links
  function perimeterPoint(d, L, B, x0, y0) {
    const P = 2 * (L + B);
    d = ((d % P) + P) % P;
    if (d < L) return { x: x0 + d, y: y0 };
    if (d < L + B) return { x: x0 + L, y: y0 + (d - L) };
    if (d < 2 * L + B) return { x: x0 + L - (d - L - B), y: y0 + B };
    return { x: x0, y: y0 + B - (d - 2 * L - B) };
  }

  function buildGeometry(measures, L, B) {
    // Neben vorhandene Inhalte legen statt sie zu überdecken
    const x0 = WM.hasContent() ? WM.contentBounds().maxX + 1.5 : 0;
    const y0 = 0;
    const roomPts = [
      { x: x0, y: y0 }, { x: x0 + L, y: y0 },
      { x: x0 + L, y: y0 + B }, { x: x0, y: y0 + B },
    ];
    const P = 2 * (L + B);
    const points = measures.map((m, i) => {
      const pos = perimeterPoint((i / measures.length) * P, L, B, x0, y0);
      // Punkte minimal nach innen versetzen, damit sie klar im Raum liegen
      const inX = pos.x === x0 ? 0.3 : pos.x === x0 + L ? -0.3 : 0;
      const inY = pos.y === y0 ? 0.3 : pos.y === y0 + B ? -0.3 : 0;
      return { x: +(pos.x + inX).toFixed(2), y: +(pos.y + inY).toFixed(2), dbm: m.dbm, note: m.note };
    });
    return { roomPts, points };
  }

  /* ---------- Start / Ende ---------- */
  async function startRun(opts) {
    document.body.classList.remove('sidebar-open');
    run = { opts, measures: [], stopFlag: false, wakeLock: null };
    $('walkOverlay').hidden = false;
    $('walkMeasure').hidden = opts.mode !== 'tap';
    try { run.wakeLock = await navigator.wakeLock?.request('screen'); } catch (_) { /* optional */ }
    if (opts.mode === 'tap') {
      $('walkCount').textContent = 'Noch keine Messung';
      setPhase('geh', 'START', 'Am Startpunkt auf „Messen“ tippen — dann im Uhrzeigersinn weiter');
    } else {
      $('walkCount').textContent = 'Erste Messung am Startpunkt …';
      loop();
    }
  }

  function cleanup() {
    if (run && run.wakeLock) { try { run.wakeLock.release(); } catch (_) {} }
    run = null;
    $('walkOverlay').hidden = true;
  }

  function finishRun() {
    if (!run) return;
    run.stopFlag = true;
    const measures = run.measures;
    const { roomL, roomB } = run.opts;
    if (measures.length < 3) {
      cleanup();
      WM.showHint('Zu wenige Messungen (mindestens 3) — Rundgang verworfen.');
      return;
    }
    const { roomPts, points } = buildGeometry(measures, roomL, roomB);
    cleanup();
    WM.commitWalk(roomPts, points);
    WM.showHint(`Rundgang abgeschlossen: ${points.length} Messpunkte übernommen`, 4000);
  }

  function cancelRun() {
    if (!run) return;
    run.stopFlag = true;
    cleanup();
    WM.showHint('Rundgang abgebrochen — nichts übernommen.');
  }

  /* ---------- UI-Anbindung ---------- */
  $('btnWalk').addEventListener('click', () => {
    const d = $('walkDialog');
    d.returnValue = '';
    d.showModal();
  });

  $('walkCancelDlg').addEventListener('click', () => $('walkDialog').close('cancel'));

  $('walkDialog').querySelector('form').addEventListener('submit', () => {
    const roomL = Math.max(1, Number($('walkL').value) || 0);
    const roomB = Math.max(1, Number($('walkB').value) || 0);
    const interval = Math.min(60, Math.max(2, Number($('walkInterval').value) || 6));
    const sound = $('walkSound').checked;
    const mode = $('walkMode').value === 'timer' ? 'timer' : 'tap';
    startRun({ roomL, roomB, interval, sound, mode });
  });

  // Gehzeit-Feld nur im Automatik-Modus relevant
  $('walkMode').addEventListener('change', () => {
    $('walkIntervalRow').style.opacity = $('walkMode').value === 'timer' ? '1' : '.45';
  });
  $('walkIntervalRow').style.opacity = '.45';

  $('walkFinish').addEventListener('click', finishRun);
  $('walkCancel').addEventListener('click', cancelRun);

  // Für automatisierte Tests
  window.WALK = { startRun, finishRun, cancelRun, probeRtt, rttToDbm, get run() { return run; } };
})();
