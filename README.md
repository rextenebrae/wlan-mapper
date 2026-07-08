# WLAN-Mapper

Werkzeug für Techniker im Handwerk: Raum erfassen, WLAN-Signalstärke an mehreren
Punkten messen, daraus eine Heatmap erzeugen und das Ergebnis als **PDF-Messprotokoll**
an den Kunden geben. Läuft komplett offline im Browser — keine Cloud, keine Konten.
Als **PWA** auf Android- und iOS-Smartphones installierbar (siehe unten).

## Starten

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .claude/serve.ps1 -Port 3620
```

Dann http://localhost:3620 öffnen. (Alternativ `index.html` direkt im Browser öffnen —
funktioniert ebenfalls, nur der Signal-Agent braucht dann ggf. CORS-Freigabe.)

## Arbeitsablauf (Standard: Rundgang)

1. **Projekt wählen/anlegen** oben in der Seitenleiste — pro Kunde oder Raum ein eigenes Projekt (Neu / Umbenennen / Löschen / Umschalten). Alles bleibt lokal auf dem Gerät.
2. **Projektdaten** eintragen (Kunde, Objekt, SSID, …).
3. **Rundgang starten** (blauer Knopf): ungefähre Raumgröße (L × B) angeben, am Startpunkt beginnen und **im Uhrzeigersinn** an der Wand entlanggehen. An jedem Messort auf den großen **📶 Messen**-Knopf tippen — das Gerät misst die WLAN-Qualität selbst. Am Startpunkt „Fertig“ tippen.
   - Alternativ **Automatik-Modus**: feste Gehzeit, das Gerät signalisiert per Vibration (Android) / Ton (iPhone), wann du stehen bleibst.
   - Die Messpunkte werden gleichmäßig auf dem Raumumfang verteilt, die **Heatmap** entsteht daraus automatisch.
4. **PDF-Report**: „PDF-Report“ oben rechts (Druckdialog → „Als PDF speichern“) — oder, wenn der Server läuft, **„PDF auf Server erzeugen“** (fertiges PDF zum Download).

**Wie misst das Gerät?** Läuft der Signal-Agent auf einem Windows-Laptop (siehe unten), wird dessen echter dBm-Wert genommen. Sonst schätzt die App die Verbindungsqualität über die Antwortzeit kleiner Netzanfragen (Netz-Probe) und bildet sie auf die dBm-Skala ab — ganz ohne Zusatz-App. *Hinweis: Browser dürfen aus Sicherheitsgründen die echte WLAN-Signalstärke des Smartphones nicht direkt auslesen; die Netz-Probe ist die praxistaugliche Näherung dafür.*

### Optional: mit Grundriss statt Rundgang
Panel **Grundriss (optional)** → Foto/Scan laden, mit **Kalibrieren** eine bekannte Strecke anklicken und die reale Länge eingeben. Dann mit dem Werkzeug **Messen** von Hand Punkte setzen. Auch ein per Werkzeug **Raum** gezeichneter Grundriss ist möglich.

Projekte werden automatisch im Browser gespeichert und lassen sich als `.json` exportieren/importieren (z. B. zur Übergabe an Kollegen).

## Server-Variante (PDF automatisch, Handy im lokalen Netz)

Statt der PWA lässt sich ein kleiner Node-Server nutzen — dann erzeugt der **Server** das PDF (Headless Edge/Chrome) und speichert alle Messdaten:

```powershell
node server.mjs        # Port 3630, im lokalen Netz erreichbar
```

Der Start zeigt die Handy-Adresse an (z. B. `http://192.168.178.60:3630`). Ablauf: Handy im selben WLAN öffnet diese Adresse, Rundgang machen, **„PDF auf Server erzeugen“** — das PDF landet in `reports/`, die Rohdaten als JSON in `data/`. Voraussetzung für die PDF-Erzeugung: Edge oder Chrome ist installiert.

## Smartphone-Installation (Android & iOS)

Die App ist eine PWA: Touch-Bedienung (Tippen = Aktion, Ziehen = Karte verschieben,
Zwei-Finger-Pinch = Zoom), mobiles Layout mit einklappbarer Seitenleiste und
Offline-Betrieb per Service Worker.

**Voraussetzung fürs Installieren:** Browser erlauben die App-Installation nur über
**HTTPS** (oder `localhost`). Der einfachste Weg:

1. Den kompletten Ordner `WLAN-Mapper` einmalig auf einen beliebigen Webspace mit
   HTTPS hochladen (z. B. als Unterordner der eigenen Website — statische Dateien
   genügen, kein Server-Code nötig).
2. Die Adresse am Handy öffnen und installieren:
   - **Android (Chrome):** Menü ⋮ → **„App installieren“** bzw. „Zum Startbildschirm hinzufügen“.
   - **iOS (Safari):** Teilen-Symbol → **„Zum Home-Bildschirm“**.
3. Danach startet die App wie eine native App vom Home-Bildschirm und funktioniert
   **komplett offline**. Alle Projektdaten bleiben lokal auf dem Gerät (Browser-Speicher);
   zum Server wird nach dem ersten Laden nichts mehr übertragen.

Ohne HTTPS (z. B. über die lokale IP des Laptops, `http://192.168.x.x:3620`) läuft die
App am Handy ebenfalls — nur Installation und Offline-Cache sind dann nicht verfügbar.

**PDF am Smartphone:** Android: Druckdialog → „Als PDF speichern“. iOS: Druckdialog →
Vorschau aufziehen → Teilen als PDF. Projekte lassen sich außerdem als `.json`
exportieren und z. B. am PC weiterbearbeiten.

## Signal-Agent (optional, Windows-Laptop)

Misst der Techniker mit dem Windows-Laptop, kann die Signalstärke automatisch übernommen werden:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File signal-agent.ps1
```

Der Agent liest `netsh wlan show interfaces` aus und stellt den Wert unter
`http://localhost:3999/signal` bereit. Die App zeigt ihn oben rechts an (grüner Punkt)
und bietet im Messpunkt-Dialog „Wert vom Agent übernehmen“ an. Ablauf: zum Messort
gehen, kurz warten, Messpunkt klicken, Wert übernehmen.

## Richtwerte Signalstärke

| dBm | Bewertung |
|---|---|
| ≥ −50 | sehr gut |
| −50 … −60 | gut |
| −60 … −67 | brauchbar (Grenze für VoIP/Streaming) |
| −67 … −75 | mäßig |
| ≤ −75 | schlecht — Ausleuchtung verbessern |

## Technik

Statische Web-App (HTML/CSS/JS, keine Abhängigkeiten): `index.html`, `styles.css`,
`app.js` (Karte, Zeichnen, Heatmap), `report.js` (PDF-Report, Export/Import).
Heatmap: Inverse-Distance-Weighting auf einem Raster, geclippt auf die Raumpolygone.
PDF über die Druckfunktion des Browsers (`@media print`-Report-Layout).
