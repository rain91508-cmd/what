# WHAT - Web-basiertes HDL-Analyse-Toolkit

[中文](README.md) | [English](README_EN.md) | [日本語](README_JA.md) | [Français](README_FR.md) | [Deutsch](README_DE.md)

WHAT ist ein webbasiertes HDL (Hardware Description Language) Code- und Wellenformanalyse-Tool.

## Projektmotivation

Die ursprüngliche Motivation für dieses Projekt war es, die Fähigkeiten der KI-gestützten Programmierung zu testen. Als Hardware-Ingenieur muss ich oft sowohl Quellcode als auch Simulationswellenformen gleichzeitig für Debugging und Analyse anzeigen. Auf dem Markt fehlen jedoch Open-Source-Tools, die Quellcode und Wellenformen eng integrieren können. Kommerzielle Tools sind teuer und unflexibel, während bestehende Open-Source-Lösungen oft fragmentiert sind und keinen vollständigen Workflow bilden können.

Daher kam mir die Idee, mit Hilfe von KI ein Analyse-Tool zu entwickeln, das meinen Nutzungsgewohnheiten entspricht. Überraschenderweise wurde der Hauptcode dieses Projekts vollständig von KI geschrieben - von der Architekturplanung bis zur spezifischen Implementierung, vom Interface-Layout bis zur Funktionslogik. Die Entwicklung der Hauptfunktionen dauerte etwa 2 Wochen, und die anschließende Fehlerbehebung und Funktionsarchitekturoptimierung dauerte weitere etwa 2 Wochen. Eine solche Entwicklungseffizienz ist in traditionellen Programmiermodellen unvorstellbar und zeigt eindrucksvoll den sprunghaften Anstieg der KI-Programmierungseffizienz.

Besonderer Dank an:
- **Trae IDE** für die Bereitstellung einer ausgezeichneten Entwicklungsumgebung und kostenloser KI-Rechenleistung
- **Doubao-seed-2.0**, **Kimi K2.5**, **GLM-5** und andere große Modelle für die Bereitstellung leistungsstarker Code-Generierungsfähigkeiten

## Funktionsmerkmale

### Quellcode-Analyse
- **Verilog/SystemVerilog-Unterstützung**: Vollständige Syntax-Hervorhebung und Code-Faltung
- **Design-Hierarchie-Browsing**: Visuelle Darstellung der Modul-Instanziierungshierarchie
- **Intelligente Code-Navigation**: Unterstützung für Definitions-Sprung, Driver-Tracing und Load-Tracing
- **Lesezeichen-Funktion**: Schnelles Markieren und Springen zu wichtigen Code-Positionen
- **Navigationsverlauf**: Unterstützung für Vorwärts-/Rückwärts-Browsing von Code-Positionen

### Wellenformanalyse
- **FST-Wellenformdatei-Unterstützung**: Hochleistungslesen großer Wellenformdateien
- **Multi-Signal-Anzeige**: Unterstützung für Signalgruppenverwaltung und benutzerdefinierte Spaltenbreiten
- **Flexible Zoom- und Pan-Funktionen**: Mausrad-Zoom, Drag-Pan, Vollbild-Anpassung
- **Cursor-Operation**: Klicken, um Cursor-Position festzulegen und Signalwerte präzise anzuzeigen
- **Wertesuchfunktion**: Unterstützung für Mustersuchen in verschiedenen Formaten (Binär, Hexadezimal, Oktal)
- **Suchverlauf**: Speichern des Suchverlaufs für schnelle wiederholte Suchen

### Integrationsfunktionen
- **Quellcode-Wellenform-Verknüpfung**: Doppelklick auf ein Signal im Code, um seine Driver-Quelle anzuzeigen
- **Design-Browser**: Schnelles Hinzufügen von Signalen zum Wellenformfenster aus dem Modulhierarchie-Baum
- **Sitzungsverwaltung**: Speichern und Wiederherstellen des vollständigen Arbeitszustands
- **Multi-Tab-Unterstützung**: Gleichzeitiges Öffnen mehrerer Quellcode- und Wellenformfenster

## Systemarchitektur

```
┌─────────────────────────────────────────────────────────────────┐
│                     Benutzer-Workflow                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   Verilog/SV-Quelldateien                                       │
│        │                                                        │
│        ↓                                                        │
│   ┌─────────────┐                                               │
│   │ Interpreter │  → KDB-Datei (Wissensdatenbank) generieren    │
│   └─────────────┘                                               │
│        │                                                        │
│        ↓                                                        │
│   ┌─────────────┐     ┌─────────────┐                          │
│   │   Server    │ ←→  │ Web-Client  │                          │
│   │  (Backend)  │     │  (Browser)  │                          │
│   └─────────────┘     └─────────────┘                          │
│        │                     │                                  │
│        ↓                     ↓                                  │
│   KDB-Dateien           Benutzeroberfläche                      │
│   Wellenformdateien     - Code-Viewer                           │
│   (FST)                 - Wellenform-Viewer                     │
│                         - Design-Browser                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Systemkomponenten

| Komponente | Verzeichnis | Funktion |
|-----------|-------------|----------|
| Interpreter | `interpreter/` | Verilog/SV-Quellcode analysieren, KDB-Wissensdatenbank generieren |
| Server | `server/` | HTTP-API bereitstellen, KDB- und Wellenformdateien bedienen |
| Web-Client | `web-client/` | Browser-Frontend-Oberfläche, Code- und Wellenformanzeige |

## Schnellstart

### Voraussetzungen

- **Node.js** 18+ (für Web-Client)
- **Rust** (für Server)
- **CMake** + **C++-Compiler** (für Interpreter)
- **Surelog** (für Interpreter, SystemVerilog-Parsing)

### Startschritte

1. **Server starten**
   ```bash
   cd server
   cargo run --release -- --kdb-dir /path/to/kdb --wave-dir /path/to/waves --port 8080
   ```

2. **Web-Client starten**
   ```bash
   cd web-client
   npm install
   npm run dev
   ```

3. **Auf die Oberfläche zugreifen**
   
   Browser öffnen und `http://localhost:3000` besuchen

## Benutzerhandbuch

### 4.1 Interpreter

Der Interpreter wird verwendet, um Verilog/SystemVerilog-Quellcode zu analysieren und KDB (Wissensdatenbank)-Dateien zu generieren. KDB-Dateien enthalten:
- Moduldefinitionen und Instanziierungshierarchie
- Signaldeklarationen und Verbindungsbeziehungen
- Driver/Load-Tracing-Informationen

#### 4.1.1 Voraussetzungen

- **Ubuntu 22.04+** oder **WSL2 (Ubuntu)**
- **CMake** 3.20+
- **GCC/G++** 11+ oder **Clang** 14+
- **Protocol Buffers** (protobuf)
- **zstd** (optional, für Komprimierung)

#### 4.1.2 Abhängigkeiten installieren

Kompilierungsabhängigkeiten auf Ubuntu/WSL installieren:

```bash
# Paketliste aktualisieren
sudo apt-get update

# Grundlegende Kompilierungstools installieren
sudo apt-get install -y build-essential cmake git

# Protocol Buffers installieren
sudo apt-get install -y protobuf-compiler libprotobuf-dev

# zstd installieren (optional, für Komprimierung)
sudo apt-get install -y libzstd-dev

# Weitere Abhängigkeiten installieren
sudo apt-get install -y python3 python3-pip pkg-config
```

#### 4.1.3 Kompilierung

**Schritt 1: Repository klonen**
```bash
cd /path/to/your/workspace
git clone <repository-url>
cd webhwd
```

**Schritt 2: Abhängigkeiten installieren**
```bash
# Paketliste aktualisieren
sudo apt-get update

# Grundlegende Kompilierungstools installieren
sudo apt-get install -y build-essential cmake git

# Protocol Buffers installieren
sudo apt-get install -y protobuf-compiler libprotobuf-dev

# zstd installieren (optional, für Komprimierung)
sudo apt-get install -y libzstd-dev
```

**Schritt 3: Projekt kompilieren**
```bash
# Kompilierungsskript ausführen
./build.sh
```

Kompilierungshinweise:
- Das Kompilierungsskript lädt und kompiliert automatisch Surelog (SystemVerilog-Parser)
- Die erste Kompilierung kann 10-20 Minuten dauern (abhängig von der Maschinenleistung)
- Kompilierungsergebnisse werden zwischengespeichert, nachfolgende Kompilierungen sind schneller
- Nach der Kompilierung befinden sich die ausführbaren Dateien unter:
  - `build_new/interpreter/hwda_interpreter`
  - `build_new/interpreter/kdb_viewer`

**Schritt 4: Installation überprüfen**
```bash
# Überprüfen, ob Interpreter verfügbar ist
./build_new/interpreter/hwda_interpreter --help

# Überprüfen, ob kdb_viewer verfügbar ist
./build_new/interpreter/kdb_viewer --help
```

#### 4.1.4 Grundlegende Verwendung

**Verilog-Datei analysieren, um KDB zu generieren:**

```bash
# Grundlegende Verwendung
./build_new/interpreter/hwda_interpreter design.v --output design.kdb

# Top-Modul angeben
./build_new/interpreter/hwda_interpreter design.v --output design.kdb -top top_module

# Include-Pfad hinzufügen
./build_new/interpreter/hwda_interpreter design.v --output design.kdb +incdir+./include

# Ausführlichen Modus verwenden, um detaillierte Logs anzuzeigen
./build_new/interpreter/hwda_interpreter design.v --output design.kdb --verbose
```

**Häufige Optionen:**

| Option | Beschreibung |
|--------|--------------|
| `-o, --output <path>` | Ausgabepfad der KDB-Datei angeben (Standard: design.kdb) |
| `-top <module>` | Top-Modul angeben |
| `+incdir+<dir>` | Include-Pfad hinzufügen |
| `-y <path>` | Bibliotheksverzeichnis hinzufügen |
| `-v <file>` | Bibliotheksdatei hinzufügen |
| `-D<name>=<value>` | Makro definieren |
| `-z, --compress` | Komprimierung aktivieren (standardmäßig aktiviert) |
| `-Z, --no-compress` | Komprimierung deaktivieren |
| `-V, --verbose` | Detaillierte Debug-Informationen anzeigen |
| `-h, --help` | Hilfeinformationen anzeigen |

#### 4.1.5 KDB-Dateien anzeigen

Verwenden Sie das kdb_viewer-Tool, um den Inhalt der generierten KDB-Datei anzuzeigen:

```bash
# KDB-Dateiinformationen anzeigen
./build_new/interpreter/kdb_viewer design.kdb

# Alle Module auflisten
./build_new/interpreter/kdb_viewer design.kdb --modules

# Alle Signale auflisten
./build_new/interpreter/kdb_viewer design.kdb --signals

# Driver-Informationen eines bestimmten Signals anzeigen
./build_new/interpreter/kdb_viewer design.kdb --driver work@top.signal_name

# Im JSON-Format ausgeben
./build_new/interpreter/kdb_viewer design.kdb --json
```

#### 4.1.6 KDB-Dateiformat

KDB (Wissensdatenbank) ist ein benutzerdefiniertes Binärformat, das Folgendes enthält:

- **Modulinformationen**: Moduldefinitionen, Instanziierungshierarchie, Parameter
- **Signalinformationen**: Signaldeklarationen, Bitbreiten, Typen (wire/reg/parameter usw.)
- **Verbindungsbeziehungen**: Driver- und Load-Informationen von Signalen
- **Quellcode-Positionen**: Dateinamen, Zeilennummern zum Springen zum Quellcode

KDB-Dateien verwenden Protocol Buffers-Serialisierung und optional zstd-Komprimierung.

#### 4.1.7 Verwendungsbeispiel

```bash
# Verilog-Datei analysieren, um KDB zu generieren
./build_new/interpreter/hwda_interpreter tests/simple.v --output tests/simple.kdb

# Generierte KDB-Dateiinformationen anzeigen
./build_new/interpreter/kdb_viewer tests/simple.kdb

# Driver-Informationen eines bestimmten Signals anzeigen
./build_new/interpreter/kdb_viewer tests/simple.kdb --driver work@top.sum
```

Detaillierte Verwendungsanweisungen finden Sie in `interpreter/README.md`.

### 4.2 Server

Der Server bietet HTTP-API für:
- Bereitstellung von KDB-Dateien
- Bereitstellung von Wellenformdateien (FST-Format)
- Bereitstellung von Signalsuch- und Abfrageschnittstellen
- Unterstützung von zwei FST-Lese-Backends: fstapi (Standard) und fst-reader

#### 4.2.1 Voraussetzungen

**Windows:**
- **Rust** 1.70+ (installiert über rustup)
- **LLVM/Clang** (für fst-reader-Backend-Bindgen)
- **vcpkg** (zur Verwaltung von C++-Abhängigkeiten)

**Ubuntu/WSL:**
- **Rust** 1.70+ 
- **LLVM/Clang** 
- **pkg-config**
- **libzstd-dev** (optional, für Komprimierung)

#### 4.2.2 Windows-Kompilierungsschritte

1. **Rust installieren**
   ```powershell
   # Über rustup installieren
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   # Oder Installer von https://rustup.rs/ herunterladen
   ```

2. **LLVM/Clang installieren**
   - LLVM von https://github.com/llvm/llvm-project/releases herunterladen
   - Nach `C:\Users\<username>\Downloads\clang+llvm-<version>-x86_64-pc-windows-msvc` extrahieren
   - Umgebungsvariable setzen: `LIBCLANG_PATH=C:\path\to\llvm\bin`

3. **vcpkg installieren**
   ```powershell
   git clone https://github.com/Microsoft/vcpkg.git C:\path\to\vcpkg
   cd C:\path\to\vcpkg
   .\bootstrap-vcpkg.bat
   ```

4. **Server kompilieren**
   ```powershell
   cd server
   $env:VCPKG_ROOT="C:\path\to\vcpkg"
   $env:LIBCLANG_PATH="C:\path\to\llvm\bin"
   cargo build --release
   ```
   
   Nach der Kompilierung befindet sich die ausführbare Datei unter: `target\release\hwda-server.exe`

#### 4.2.3 Ubuntu/WSL-Kompilierungsschritte

1. **Abhängigkeiten installieren**
   ```bash
   sudo apt-get update
   sudo apt-get install -y build-essential pkg-config libzstd-dev
   
   # Rust installieren
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   source $HOME/.cargo/env
   
   # LLVM/Clang installieren
   sudo apt-get install -y llvm libclang-dev
   ```

2. **Server kompilieren**
   ```bash
   cd server
   cargo build --release
   ```
   
   Nach der Kompilierung befindet sich die ausführbare Datei unter: `target/release/hwda-server`

#### 4.2.4 Grundlegende Verwendung

**Server starten:**

```bash
# Grundlegende Verwendung (Standard-fstapi-Backend verwenden)
./hwda-server --kdb-dir /path/to/kdb --wave-dir /path/to/waves --port 8080

# fst-reader-Backend verwenden
./hwda-server --kdb-dir /path/to/kdb --wave-dir /path/to/waves --fst-backend fst-reader

# Detaillierte Debug-Logs aktivieren
./hwda-server --kdb-dir /path/to/kdb --wave-dir /path/to/waves --log-level debug --verbose

# Cache beim Start löschen
./hwda-server --kdb-dir /path/to/kdb --wave-dir /path/to/waves --clear-cache-on-startup

# Web-Client-Statische-Dateien-Service aktivieren
./hwda-server --kdb-dir /path/to/kdb --wave-dir /path/to/waves --web-dir /path/to/web-client/dist
```

**Häufige Optionen:**

| Option | Beschreibung | Standard |
|--------|--------------|----------|
| `--kdb-dir <path>` | KDB-Dateiverzeichnis | `./kdb` |
| `--wave-dir <path>` | Wellenformdateiverzeichnis | `./waves` |
| `--port <port>` | Service-Port | `8080` |
| `--host <host>` | Bindungsadresse | `0.0.0.0` |
| `--fst-backend <backend>` | FST-Lese-Backend (`fstapi` oder `fst-reader`) | `fstapi` |
| `--log-level <level>` | Log-Level (`trace`, `debug`, `info`, `warn`, `error`) | `info` |
| `--verbose` | Detaillierte Debug-Ausgabe aktivieren (nur wirksam bei `log-level=debug`) | `false` |
| `--web-dir <path>` | Web-Client-Statische-Dateien-Verzeichnis | - |
| `--clear-cache-on-startup` | Alle Caches beim Start löschen | `false` |
| `--enable-cors` | CORS aktivieren | `true` |
| `--cache-capacity-mb <size>` | LRU-Cache-Kapazität (MB) | `512` |

**Hilfe anzeigen:**

```bash
./hwda-server --help
```

#### 4.2.5 FST-Backend-Auswahl

Der Server unterstützt zwei FST-Lese-Backends:

1. **fstapi** (Standard)
   - Verwendet GTKWaves libfst C-Bibliothek
   - Gute Kompatibilität, unterstützt alle FST-Funktionen
   - Erfordert C++-Kompilierungsumgebung

2. **fst-reader** (Reines Rust)
   - Reine Rust-Implementierung, keine C++-Abhängigkeiten
   - Bessere Leistung, geringerer Speicherverbrauch
   - Mit `--fst-backend fst-reader` aktivieren

**Backend-Wechsel-Beispiel:**
```bash
# fstapi-Backend verwenden (Standard)
./hwda-server --wave-dir ./waves

# fst-reader-Backend verwenden
./hwda-server --wave-dir ./waves --fst-backend fst-reader
```

#### 4.2.6 API-Schnittstellen

Der Server bietet die folgenden Haupt-APIs:

- `GET /api/kdb` - Alle KDB-Dateien auflisten
- `GET /api/kdb/{name}/signals` - Signalliste in KDB abrufen
- `GET /api/wave` - Alle Wellenformdateien auflisten
- `GET /api/wave/{name}/signals` - Signalliste in Wellenformdatei abrufen
- `GET /api/wave/{name}/lod/{lod}/tile/{start}/{span}/{count}/signals/{signal_ids}/data` - Wellenformdaten abrufen

Detaillierte API-Dokumentation finden Sie in `server/API.md`.

### 4.3 Web-Client

#### 4.3.1 Mit Server verbinden

Beim ersten Öffnen der Anwendung müssen Sie sich mit dem Server verbinden:

1. Serveradresse und Port im Verbindungsdialog eingeben
2. Standardadresse ist `localhost:8080`
3. Auf die Schaltfläche "Connect" klicken
4. Nach erfolgreicher Verbindung wird die Liste der verfügbaren KDB-Dateien automatisch angezeigt

#### 4.3.2 KDB- und Wellenformdateien laden

**KDB-Datei laden:**
1. Auf Menü **File → Open KDB** klicken
2. KDB-Datei aus der Liste auswählen
3. Nach dem Laden wird die Modulhierarchie im linken Design-Browser angezeigt

**Wellenformdatei laden:**
1. Auf Menü **File → Open Waveform** klicken
2. Wellenformdatei (FST-Format) aus der Liste auswählen
3. Oder "Use Mock Data" auswählen, um simulierte Daten für Tests zu verwenden

#### 4.3.3 Design-Browser

Der Design-Browser befindet sich im linken Panel und zeigt die Design-Hierarchie:

- **Modulbaum**: Top-Level-Module und Submodul-Instanzen anzeigen
- **Signalliste**: Nach Auswahl eines Moduls alle Signale dieses Moduls anzeigen
- **Suchfunktion**: Signalnamen oder Modulnamen in das Suchfeld eingeben, um zu filtern

**Bedienungsmethoden:**
- Auf Modul klicken: Signale dieses Moduls in der Signalliste anzeigen
- Auf Modul doppelklicken: Quellcode dieses Moduls öffnen
- Auf Signal doppelklicken: Signal zum aktuellen Wellenformfenster hinzufügen
- Kontextmenü: Weitere Bedienungsoptionen

#### 4.3.4 Quellcode-Fenster

Das Quellcode-Fenster wird verwendet, um Verilog/SystemVerilog-Code anzuzeigen:

**Grundfunktionen:**
- Syntax-Hervorhebung
- Code-Faltung (module, always, begin-end-Blöcke)
- Zeilennummernanzeige

**Driver/Load-Tracing:**
1. Auf Signalnamen im Code klicken
2. "Find Drivers" oder "Find Loads" im Popup-Menü auswählen
3. Tracing-Ergebnisse werden im Nachrichtenfenster unten angezeigt
4. Auf Tracing-Ergebnisse doppelklicken, um zur entsprechenden Quellcode-Position zu springen

**Lesezeichen-Funktion:**
- Auf Menü **Navigate → Add Bookmark** klicken, um Lesezeichen hinzuzufügen
- Lesezeichen werden im Lesezeichen-Panel auf der rechten Seite angezeigt
- Auf Lesezeichen doppelklicken, um schnell zur entsprechenden Code-Position zu springen

**Navigationsverlauf:**
- Toolbar-Buttons ← → für Vorwärts-/Rückwärts-Navigation
- Unterstützung für Cross-File-Navigationsverlauf

#### 4.3.5 Wellenformfenster

Das Wellenformfenster wird verwendet, um Simulationswellenformen anzuzeigen:

**Signalverwaltung:**
- Signale vom Design-Browser in das Wellenformfenster ziehen
- Signale im Design-Browser doppelklicken, um sie zur Wellenform hinzuzufügen
- Signalgruppierungsfunktion verwenden, um Signale zu organisieren
- Rechtsklick auf Signale, um sie zu löschen oder zu verschieben

**Ansichtsoperationen:**
- **Zoom**: Mausrad oder Toolbar-Buttons +/-
- **Pan**: Wellenformbereich ziehen
- **Vollbild**: Auf Toolbar-Button "Fit" klicken
- **Cursor-Operation**: Auf Wellenform klicken, um Cursor-Position festzulegen

**Wertesuche:**
1. Auf Toolbar-Button "Search" klicken
2. Zu suchenden Wert eingeben (unterstützt Binär, Hexadezimal usw.)
3. Suchergebnisse werden hervorgehoben

**Zeitanzeige:**
- Toolbar zeigt die Zeit der aktuellen Cursor-Position an
- Möglichkeit, Zeitwert manuell einzugeben, um zu einer bestimmten Position zu springen

**Multi-Fenster-Unterstützung:**
- Auf Button "+" klicken, um neues Wellenformfenster hinzuzufügen
- Jedes Fenster kann verschiedene Signalkombinationen anzeigen
- Unterstützung für gleichzeitiges Öffnen mehrerer Quellcode-Fenster

#### 4.3.6 Nachrichtenfenster

Das Nachrichtenfenster befindet sich im unteren Panel:

- **Driver-Tracing-Ergebnisse**: Driver-Quellen von Signalen anzeigen
- **Systemnachrichten**: Betriebsergebnisse und Fehlerinformationen anzeigen
- **Doppelklick-Sprung**: Auf Tracing-Ergebnisse doppelklicken, um zum entsprechenden Code zu springen

#### 4.3.7 Sitzungsverwaltung

**Sitzung speichern:**
1. Auf Menü **File → Save Session** klicken
2. Sitzungsnamen eingeben
3. Gespeicherter Inhalt umfasst:
   - Serververbindungsinformationen
   - Aktuell geladene KDB- und Wellenformdateien
   - Alle geöffneten Quellcode-Fenster
   - Alle geöffneten Wellenformfenster (einschließlich Signallisten)
   - Lesezeichen

**Sitzung wiederherstellen:**
1. Auf Menü **File → Restore Session** klicken
2. Gespeicherte Sitzung aus der Liste auswählen
3. Das System führt automatisch folgende Aktionen durch:
   - Mit Server verbinden
   - KDB- und Wellenformdateien laden
   - Alle Fenster und Lesezeichen wiederherstellen

**Sitzungen verwalten:**
- Möglichkeit, unerwünschte Sitzungen im Speichern/Wiederherstellen-Dialog zu löschen
- Unterstützung für die Suche nach gespeicherten Sitzungen
- Sitzungsdaten werden im Browser-LocalStorage gespeichert

#### 4.3.8 Menüleiste

| Menü | Funktion |
|------|----------|
| **File** | |
| Connect | Mit Server verbinden |
| Disconnect | Vom Server trennen |
| Open KDB | KDB-Dateiauswahldialog öffnen |
| Open Waveform | Wellenformdateiauswahldialog öffnen |
| Close KDB | Aktuelles KDB schließen |
| Close Waveform | Aktuelle Wellenform schließen |
| Save Session | Aktuellen Arbeitszustand speichern |
| Restore Session | Gespeicherten Arbeitszustand wiederherstellen |
| **View** | |
| Zoom In | In Wellenform-Zeitleiste zoomen |
| Zoom Out | Aus Wellenform-Zeitleiste zoomen |
| Zoom Full | Wellenform an Fensterbreite anpassen |
| **Navigate** | |
| History Back | Zur vorherigen Code-Position navigieren |
| History Forward | Zur nächsten Code-Position navigieren |
| Add Bookmark | Lesezeichen zur aktuellen Position hinzufügen |
| Find Driver | Driver-Quelle des ausgewählten Signals finden (Signal muss im Code ausgewählt werden) |
| Find Definition | Definition der ausgewählten Instanz finden (Instanz muss im Code ausgewählt werden) |
| **Waveform** | |
| Add Signal | Signal zum Wellenformfenster hinzufügen (Signal muss im Signal-Panel doppelgeklickt werden) |
| Remove Signal | Signal aus Wellenformfenster entfernen |
| OPFS Cache | OPFS-Cache-Schalter umschalten |
| Memory Cache | Speicher-Cache-Schalter umschalten |
| **Help** | |
| KDB Debug Tool | KDB-Debug-Tool öffnen |
| About | Projekt-GitHub-Seite öffnen |

#### 4.3.9 Toolbar

| Button | Funktion |
|--------|----------|
| 🔍+ | In Wellenform zoomen |
| 🔍- | Aus Wellenform zoomen |
| 🔍↔ | Wellenform an Fenster anpassen |
| 🔍 | Wert suchen |
| ← | Rückwärts navigieren |
| → | Vorwärts navigieren |
| + | Neuen Tab hinzufügen |
| 📍 | Lesezeichen hinzufügen |

## FAQ

### F: Verbindung zum Server fehlgeschlagen?

1. Bestätigen, dass der Server gestartet ist
2. Überprüfen, ob Serveradresse und Port korrekt sind
3. Firewall-Einstellungen überprüfen
4. Browser-Konsole auf Fehlermeldungen überprüfen

### F: Wellenform-Laden ist langsam?

1. Bei großen Wellenformdateien erfordert der erste Ladevorgang Download und Dekomprimierung
2. Das System speichert geladene Daten automatisch zwischen
3. Nachfolgende Zugriffe sind schneller

### F: Wie speichere ich meinen Arbeitszustand?

Verwenden Sie die Funktion **File → Save Session**, um alle aktuellen Fenster und Einstellungen zu speichern, und stellen Sie sie beim nächsten Mal über **Restore Session** schnell wieder her.

### F: Welche Browser werden unterstützt?

- Chrome 90+
- Firefox 90+
- Safari 15+
- Edge 90+

Erfordert Unterstützung für WebGL 2.0 und WebAssembly.

## Bekannte Probleme

### Code-Qualitätsprobleme
- **Code-Struktur-Chaos**: Da hauptsächlich von KI generiert, weist der Code Wiederholungs- und Organisationsprobleme auf. Einige Funktionsimplementierungen sind übermäßig komplex mit hoher Kopplung zwischen Modulen. Dies ist ein wichtiges Problem, das aktuelle KI-Programmiermodelle und Toolchains weiterhin lösen müssen.

### Leistungsprobleme
- **Interpreter-Speicherverbrauch**: Bei großen Designs dauert das Parsing durch den Interpreter lange und verbraucht zu viel Speicher, was zu OOM-Fehlern (Out of Memory) führen kann. Es wird empfohlen, große Designs stapelweise zu verarbeiten oder den Systemspeicher zu erhöhen.
- **Web-Client-Rendering-Flüssigkeit**: WebGL2-Rendering wurde noch nicht implementiert, es wird nur Canvas2D für Wellenform-Rendering verwendet.

### Funktionsvollständigkeit
- **Unzureichende Testabdeckung**: Viele Funktionen verfügen nicht über ausreichende Tests und können eine unangemessene Behandlung von Grenzfällen aufweisen. Community-Beiträge von Testfällen und Fehlerberichten sind willkommen.

## Weitere Ressourcen

- **Web-Client-Entwicklungsdokumentation**: `web-client/README.md`
- **Server-Dokumentation**: `server/README.md`
- **API-Dokumentation**: `server/docs/API.md`

## Lizenz

MIT License
