# WLAN-Mapper über GitHub Pages veröffentlichen

Das lokale Git-Repository ist bereits fertig (ein Commit auf Branch `main`).
Es fehlen nur noch: Repo bei GitHub anlegen, hochladen (push), Pages einschalten.

Danach ist die App unter einer HTTPS-Adresse erreichbar und lässt sich auf
Android/iPhone installieren.

---

## Weg 1 — ohne Zusatzsoftware (Browser + 3 Befehle)

**1. Leeres Repo bei GitHub anlegen**
- Auf <https://github.com/new> gehen.
- *Repository name*: `wlan-mapper`
- Sichtbarkeit: **Public** (GitHub Pages ist bei kostenlosen Konten nur für öffentliche Repos gratis).
- **Nichts** ankreuzen (kein README, kein .gitignore) → *Create repository*.

**2. Lokal hochladen** — im Ordner `WLAN-Mapper` diese Befehle (PowerShell oder Git-Bash).
`DEIN-GITHUBNAME` durch deinen GitHub-Benutzernamen ersetzen:

```
git remote add origin https://github.com/DEIN-GITHUBNAME/wlan-mapper.git
git push -u origin main
```

Beim ersten Push öffnet sich ein GitHub-Login im Browser — einmal bestätigen.

**3. Pages einschalten**
- Im Repo auf **Settings → Pages**.
- Unter *Build and deployment* → *Source*: **Deploy from a branch**.
- *Branch*: **main**, Ordner **/ (root)** → *Save*.
- Nach ~1 Minute erscheint oben die Adresse:

```
https://DEIN-GITHUBNAME.github.io/wlan-mapper/
```

Diese Adresse aufs Handy schicken → installieren (siehe unten).

---

## Weg 2 — mit GitHub-CLI (schneller, wenn `gh` installiert ist)

```
winget install --id GitHub.cli        # falls noch nicht vorhanden, dann Terminal neu öffnen
gh auth login                         # einmalig im Browser anmelden
gh repo create wlan-mapper --public --source=. --push
```

Pages danach wie in Weg 1, Schritt 3 einschalten — oder per CLI:

```
gh api -X POST repos/DEIN-GITHUBNAME/wlan-mapper/pages -f "source[branch]=main" -f "source[path]=/"
```

---

## App aufs Handy installieren

Die Pages-Adresse (`https://…github.io/wlan-mapper/`) am Handy öffnen:

- **Android (Chrome):** Menü ⋮ → *App installieren* / *Zum Startbildschirm hinzufügen*
- **iPhone (Safari):** Teilen-Symbol → *Zum Home-Bildschirm*

Danach läuft die App offline vom Home-Bildschirm. Messdaten bleiben lokal auf
dem Gerät. Zum **Teilen** einfach die Adresse weitergeben (Link/QR-Code).

---

## Später etwas ändern und neu veröffentlichen

Nach Änderungen an den Dateien:

```
git add -A
git commit -m "update"
git push
```

Wichtig bei App-Änderungen: in `sw.js` die Zeile `const CACHE = 'wlanmapper-vN'`
hochzählen (z. B. v7 → v8), sonst behalten schon installierte Geräte die alte
Version aus dem Offline-Cache.

> Hinweis: `server.mjs` und der Signal-Agent laufen bei GitHub Pages **nicht**
> (Pages liefert nur statische Dateien aus). Für die Handy-Nutzung ist das kein
> Problem — der PDF-Report läuft dort über den Druckdialog des Browsers
> („Als PDF speichern"). Der Server ist nur für die Variante „PDF zentral auf
> dem PC erzeugen" gedacht.
