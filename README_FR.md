# WHAT - Boîte à Outils d'Analyse HDL Web

[中文](README.md) | [English](README_EN.md) | [日本語](README_JA.md) | [Français](README_FR.md) | [Deutsch](README_DE.md) | [Русский](README_RU.md)

WHAT est un outil d'analyse de code et de formes d'onde HDL (Langage de Description Matériel) basé sur le Web.

## Motivation du Projet

La motivation originale de ce projet était de tester les capacités de la programmation assistée par IA. En tant qu'ingénieur matériel, j'ai souvent besoin d'afficher simultanément le code source et les formes d'onde de simulation pour le débogage et l'analyse. Cependant, il manque d'outils open source sur le marché qui peuvent intégrer étroitement le code source et les formes d'onde. Les outils commerciaux sont coûteux et peu flexibles, tandis que les solutions open source existantes sont souvent fragmentées et ne peuvent pas former un flux de travail complet.

Par conséquent, j'ai eu l'idée d'utiliser l'IA pour développer un outil d'analyse adapté à mes habitudes d'utilisation. De manière surprenante, le code principal de ce projet a été entièrement écrit par l'IA - de la conception architecturale à l'implémentation spécifique, de la mise en page de l'interface à la logique fonctionnelle. Le développement des fonctionnalités principales a pris environ 2 semaines, et les corrections de bogues et l'optimisation de l'architecture fonctionnelle ont pris environ 2 semaines supplémentaires. Une telle efficacité de développement est inimaginable dans les modèles de programmation traditionnels, démontrant pleinement l'amélioration spectaculaire de l'efficacité de la programmation par IA.

Remerciements particuliers à :
- **Trae IDE** pour fournir un excellent environnement de développement et un support de puissance de calcul IA gratuit
- **Doubao-seed-2.0**, **Kimi K2.5**, **GLM-5** et autres grands modèles pour fournir de puissantes capacités de génération de code

## Caractéristiques

### Analyse de Code Source
- **Support Verilog/SystemVerilog** : Coloration syntaxique complète et pliage de code
- **Navigation Hiérarchique de Conception** : Affichage visuel de la hiérarchie d'instanciation des modules
- **Navigation Intelligente dans le Code** : Support pour le saut de définition, le traçage des pilotes et des charges
- **Fonction de Signets** : Marquer et sauter rapidement vers des positions de code clés
- **Historique de Navigation** : Support pour la navigation avant/arrière des positions de code
- **Affichage Développé des Valeurs de Signaux** : Afficher les valeurs des signaux au temps actuel du curseur directement dans le code source, supportant l'affichage multi-base

### Analyse de Formes d'Onde
- **Support des Fichiers de Formes d'Onde FST** : Lecture haute performance de grands fichiers de formes d'onde
- **Affichage Multi-Signaux** : Support pour la gestion de groupes de signaux et les largeurs de colonnes personnalisées
- **Zoom et Panoramique Flexibles** : Zoom molette souris, panoramique par glissement, ajustement plein écran
- **Opération de Curseur** : Cliquer pour définir la position du curseur, afficher précisément les valeurs des signaux
- **Fonction de Recherche de Valeurs** : Support pour les recherches de motifs dans plusieurs formats (binaire, hexadécimal, octal)
- **Historique de Recherche** : Sauvegarder l'historique de recherche pour des recherches répétées rapides
- **Vue Tableau** : Afficher les valeurs des signaux sous forme de tableau pour des plages de temps spécifiques, supportant l'affichage multi-base, le filtrage de métadonnées et la pagination

### Fonctionnalités d'Intégration
- **Liaison Source-Formes d'Onde** : Double-cliquer sur un signal dans le code pour voir sa source de pilote
- **Navigateur de Conception** : Ajout rapide de signaux à la fenêtre de formes d'onde depuis l'arborescence de la hiérarchie des modules
- **Gestion de Session** : Sauvegarde et restauration complète de l'état de travail
- **Support Multi-Onglets** : Ouvrir simultanément plusieurs fenêtres de code source et de formes d'onde

## Architecture du Système

```
┌─────────────────────────────────────────────────────────────────┐
│                    Flux de Travail Utilisateur                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   Fichiers Source Verilog/SV                                    │
│        │                                                        │
│        ↓                                                        │
│   ┌─────────────┐                                               │
│   │ Interpréteur│  → Générer fichier KDB (Base de Connaissances)│
│   └─────────────┘                                               │
│        │                                                        │
│        ↓                                                        │
│   ┌─────────────┐     ┌─────────────┐                          │
│   │   Serveur   │ ←→  │ Client Web  │                          │
│   │  (Backend)  │     │ (Navigateur)│                          │
│   └─────────────┘     └─────────────┘                          │
│        │                     │                                  │
│        ↓                     ↓                                  │
│   Fichiers KDB          Interface Utilisateur                   │
│   Fichiers de Formes    - Visionneuse de Code                   │
│   d'Onde (FST)          - Visionneuse de Formes d'Onde          │
│                         - Navigateur de Conception              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Composants du Système

| Composant | Répertoire | Fonction |
|-----------|-----------|----------|
| Interpréteur | `interpreter/` | Analyser le code source Verilog/SV, générer la base de connaissances KDB |
| Serveur | `server/` | Fournir l'API HTTP, servir les fichiers KDB et de formes d'onde |
| Client Web | `web-client/` | Interface frontend du navigateur, visualisation du code et des formes d'onde |

## Démarrage Rapide

### Prérequis

- **Node.js** 18+ (pour le Client Web)
- **Rust** (pour le Serveur)
- **CMake** + **Compilateur C++** (pour l'Interpréteur)
- **Surelog** (pour l'Interpréteur, analyse SystemVerilog)

### Étapes de Démarrage

1. **Démarrer le Serveur**
   ```bash
   cd server
   cargo run --release -- --kdb-dir /path/to/kdb --wave-dir /path/to/waves --port 8080
   ```

2. **Démarrer le Client Web**
   ```bash
   cd web-client
   npm install
   npm run dev
   ```

3. **Accéder à l'Interface**
   
   Ouvrir le navigateur et visiter `http://localhost:3000`

## Guide Utilisateur

### 4.1 Interpréteur

L'interpréteur est utilisé pour analyser le code source Verilog/SystemVerilog et générer des fichiers KDB (Base de Connaissances). Les fichiers KDB contiennent :
- Définitions de modules et hiérarchie d'instanciation
- Déclarations de signaux et relations de connexion
- Informations de traçage des pilotes/charges

#### 4.1.1 Prérequis

- **Ubuntu 22.04+** ou **WSL2 (Ubuntu)**
- **CMake** 3.20+
- **GCC/G++** 11+ ou **Clang** 14+
- **Protocol Buffers** (protobuf)
- **zstd** (optionnel, pour la compression)

#### 4.1.2 Installation des Dépendances

Installer les dépendances de compilation sur Ubuntu/WSL :

```bash
# Mettre à jour la liste des paquets
sudo apt-get update

# Installer les outils de compilation de base
sudo apt-get install -y build-essential cmake git

# Installer Protocol Buffers
sudo apt-get install -y protobuf-compiler libprotobuf-dev

# Installer zstd (optionnel, pour la compression)
sudo apt-get install -y libzstd-dev

# Installer les autres dépendances
sudo apt-get install -y python3 python3-pip pkg-config
```

#### 4.1.3 Compilation

**Étape 1 : Cloner le Dépôt**
```bash
cd /path/to/your/workspace
git clone <repository-url>
cd webhwd
```

**Étape 2 : Installer les Dépendances**
```bash
# Mettre à jour la liste des paquets
sudo apt-get update

# Installer les outils de compilation de base
sudo apt-get install -y build-essential cmake git

# Installer Protocol Buffers
sudo apt-get install -y protobuf-compiler libprotobuf-dev

# Installer zstd (optionnel, pour la compression)
sudo apt-get install -y libzstd-dev
```

**Étape 3 : Compiler le Projet**
```bash
# Exécuter le script de compilation
./build.sh
```

Notes de compilation :
- Le script de compilation télécharge et compile automatiquement Surelog (analyseur SystemVerilog)
- La première compilation peut prendre 10-20 minutes (selon les performances de la machine)
- Les résultats de compilation sont mis en cache, les compilations suivantes seront plus rapides
- Après compilation, les exécutables sont situés à :
  - `build_new/interpreter/hwda_interpreter`
  - `build_new/interpreter/kdb_viewer`

**Étape 4 : Vérifier l'Installation**
```bash
# Vérifier si l'interpréteur est disponible
./build_new/interpreter/hwda_interpreter --help

# Vérifier si kdb_viewer est disponible
./build_new/interpreter/kdb_viewer --help
```

#### 4.1.4 Utilisation de Base

**Analyser un fichier Verilog pour générer un KDB :**

```bash
# Utilisation de base
./build_new/interpreter/hwda_interpreter design.v --output design.kdb

# Spécifier le module supérieur
./build_new/interpreter/hwda_interpreter design.v --output design.kdb -top top_module

# Ajouter un chemin d'inclusion
./build_new/interpreter/hwda_interpreter design.v --output design.kdb +incdir+./include

# Utiliser le mode verbeux pour afficher les journaux détaillés
./build_new/interpreter/hwda_interpreter design.v --output design.kdb --verbose
```

**Options Courantes :**

| Option | Description |
|--------|-------------|
| `-o, --output <path>` | Spécifier le chemin du fichier KDB de sortie (défaut : design.kdb) |
| `-top <module>` | Spécifier le module supérieur |
| `+incdir+<dir>` | Ajouter un chemin d'inclusion |
| `-y <path>` | Ajouter un répertoire de bibliothèque |
| `-v <file>` | Ajouter un fichier de bibliothèque |
| `-D<name>=<value>` | Définir une macro |
| `-z, --compress` | Activer la compression (activé par défaut) |
| `-Z, --no-compress` | Désactiver la compression |
| `-V, --verbose` | Afficher les informations de débogage détaillées |
| `-h, --help` | Afficher les informations d'aide |

#### 4.1.5 Visualiser les Fichiers KDB

Utiliser l'outil kdb_viewer pour visualiser le contenu du fichier KDB généré :

```bash
# Visualiser les informations du fichier KDB
./build_new/interpreter/kdb_viewer design.kdb

# Lister tous les modules
./build_new/interpreter/kdb_viewer design.kdb --modules

# Lister tous les signaux
./build_new/interpreter/kdb_viewer design.kdb --signals

# Visualiser les informations du pilote d'un signal spécifique
./build_new/interpreter/kdb_viewer design.kdb --driver work@top.signal_name

# Sortie au format JSON
./build_new/interpreter/kdb_viewer design.kdb --json
```

#### 4.1.6 Format de Fichier KDB

KDB (Base de Connaissances) est un format binaire personnalisé contenant :

- **Informations de Module** : Définitions de modules, hiérarchie d'instanciation, paramètres
- **Informations de Signal** : Déclarations de signaux, largeurs de bits, types (wire/reg/parameter, etc.)
- **Relations de Connexion** : Informations sur les pilotes et charges des signaux
- **Emplacements du Code Source** : Noms de fichiers, numéros de ligne pour sauter vers le code source

Les fichiers KDB utilisent la sérialisation Protocol Buffers et utilisent optionnellement la compression zstd.

#### 4.1.7 Exemple d'Utilisation

```bash
# Analyser un fichier Verilog pour générer un KDB
./build_new/interpreter/hwda_interpreter tests/simple.v --output tests/simple.kdb

# Visualiser les informations du fichier KDB généré
./build_new/interpreter/kdb_viewer tests/simple.kdb

# Visualiser les informations du pilote d'un signal spécifique
./build_new/interpreter/kdb_viewer tests/simple.kdb --driver work@top.sum
```

Pour des instructions d'utilisation détaillées, veuillez consulter `interpreter/README.md`.

### 4.2 Serveur

Le serveur fournit une API HTTP pour :
- Servir les fichiers KDB
- Servir les fichiers de formes d'onde (format FST)
- Fournir des interfaces de recherche et de requête de signaux
- Supporter deux backends de lecture FST : fstapi (par défaut) et fst-reader

#### 4.2.1 Prérequis

**Windows :**
- **Rust** 1.70+ (installé via rustup)
- **LLVM/Clang** (pour le bindgen du backend fst-reader)
- **vcpkg** (pour la gestion des dépendances C++)

**Ubuntu/WSL :**
- **Rust** 1.70+ 
- **LLVM/Clang** 
- **pkg-config**
- **libzstd-dev** (optionnel, pour la compression)

#### 4.2.2 Étapes de Compilation Windows

1. **Installer Rust**
   ```powershell
   # Installer via rustup
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   # Ou télécharger l'installateur depuis https://rustup.rs/
   ```

2. **Installer LLVM/Clang**
   - Télécharger LLVM depuis https://github.com/llvm/llvm-project/releases
   - Extraire vers `C:\Users\<username>\Downloads\clang+llvm-<version>-x86_64-pc-windows-msvc`
   - Définir la variable d'environnement : `LIBCLANG_PATH=C:\path\to\llvm\bin`

3. **Installer vcpkg**
   ```powershell
   git clone https://github.com/Microsoft/vcpkg.git C:\path\to\vcpkg
   cd C:\path\to\vcpkg
   .\bootstrap-vcpkg.bat
   ```

4. **Compiler le Serveur**
   ```powershell
   cd server
   $env:VCPKG_ROOT="C:\path\to\vcpkg"
   $env:LIBCLANG_PATH="C:\path\to\llvm\bin"
   cargo build --release
   ```
   
   Après compilation, l'exécutable est situé à : `target\release\hwda-server.exe`

#### 4.2.3 Étapes de Compilation Ubuntu/WSL

1. **Installer les Dépendances**
   ```bash
   sudo apt-get update
   sudo apt-get install -y build-essential pkg-config libzstd-dev
   
   # Installer Rust
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   source $HOME/.cargo/env
   
   # Installer LLVM/Clang
   sudo apt-get install -y llvm libclang-dev
   ```

2. **Compiler le Serveur**
   ```bash
   cd server
   cargo build --release
   ```
   
   Après compilation, l'exécutable est situé à : `target/release/hwda-server`

#### 4.2.4 Utilisation de Base

**Démarrer le Serveur :**

```bash
# Utilisation de base (utilisant le backend fstapi par défaut)
./hwda-server --kdb-dir /path/to/kdb --wave-dir /path/to/waves --port 8080

# Utiliser le backend fst-reader
./hwda-server --kdb-dir /path/to/kdb --wave-dir /path/to/waves --fst-backend fst-reader

# Activer les journaux de débogage détaillés
./hwda-server --kdb-dir /path/to/kdb --wave-dir /path/to/waves --log-level debug --verbose

# Effacer le cache au démarrage
./hwda-server --kdb-dir /path/to/kdb --wave-dir /path/to/waves --clear-cache-on-startup

# Activer le service de fichiers statiques du client Web
./hwda-server --kdb-dir /path/to/kdb --wave-dir /path/to/waves --web-dir /path/to/web-client/dist
```

**Options Courantes :**

| Option | Description | Défaut |
|--------|-------------|--------|
| `--kdb-dir <path>` | Répertoire des fichiers KDB | `./kdb` |
| `--wave-dir <path>` | Répertoire des fichiers de formes d'onde | `./waves` |
| `--port <port>` | Port de service | `8080` |
| `--host <host>` | Adresse de liaison | `0.0.0.0` |
| `--fst-backend <backend>` | Backend de lecture FST (`fstapi` ou `fst-reader`) | `fstapi` |
| `--log-level <level>` | Niveau de journal (`trace`, `debug`, `info`, `warn`, `error`) | `info` |
| `--verbose` | Activer la sortie de débogage détaillée (efficace uniquement quand `log-level=debug`) | `false` |
| `--web-dir <path>` | Répertoire de fichiers statiques du client Web | - |
| `--clear-cache-on-startup` | Effacer tous les caches au démarrage | `false` |
| `--enable-cors` | Activer CORS | `true` |
| `--cache-capacity-mb <size>` | Capacité du cache LRU (Mo) | `512` |

**Voir l'Aide :**

```bash
./hwda-server --help
```

#### 4.2.5 Sélection du Backend FST

Le serveur supporte deux backends de lecture FST :

1. **fstapi** (par défaut)
   - Utilise la bibliothèque C libfst de GTKWave
   - Bonne compatibilité, supporte toutes les fonctionnalités FST
   - Nécessite un environnement de compilation C++

2. **fst-reader** (Rust pur)
   - Implémentation Rust pure, sans dépendances C++
   - Meilleures performances, utilisation mémoire plus faible
   - Activer avec `--fst-backend fst-reader`

**Exemple de Changement de Backend :**
```bash
# Utiliser le backend fstapi (par défaut)
./hwda-server --wave-dir ./waves

# Utiliser le backend fst-reader
./hwda-server --wave-dir ./waves --fst-backend fst-reader
```

#### 4.2.6 Interfaces API

Le serveur fournit les API principales suivantes :

- `GET /api/kdb` - Lister tous les fichiers KDB
- `GET /api/kdb/{name}/signals` - Obtenir la liste des signaux dans KDB
- `GET /api/wave` - Lister tous les fichiers de formes d'onde
- `GET /api/wave/{name}/signals` - Obtenir la liste des signaux dans le fichier de formes d'onde
- `GET /api/wave/{name}/lod/{lod}/tile/{start}/{span}/{count}/signals/{signal_ids}/data` - Obtenir les données de formes d'onde

Pour la documentation API détaillée, veuillez consulter `server/API.md`.

### 4.3 Client Web

#### 4.3.1 Se Connecter au Serveur

Lors de l'ouverture de l'application pour la première fois, vous devez vous connecter au Serveur :

1. Entrer l'adresse du serveur et le port dans la boîte de dialogue de connexion
2. L'adresse par défaut est `localhost:8080`
3. Cliquer sur le bouton "Connect"
4. Après connexion réussie, la liste des fichiers KDB disponibles s'affichera automatiquement

#### 4.3.2 Charger les Fichiers KDB et de Formes d'Onde

**Charger un Fichier KDB :**
1. Cliquer sur le menu **File → Open KDB**
2. Sélectionner le fichier KDB dans la liste
3. Après chargement, la hiérarchie des modules s'affichera dans le navigateur de conception à gauche

**Charger un Fichier de Formes d'Onde :**
1. Cliquer sur le menu **File → Open Waveform**
2. Sélectionner le fichier de formes d'onde (format FST) dans la liste
3. Ou sélectionner "Use Mock Data" pour utiliser des données simulées pour les tests

#### 4.3.3 Navigateur de Conception

Le navigateur de conception est situé dans le panneau gauche, affichant la hiérarchie de conception :

- **Arbre des Modules** : Afficher les modules de niveau supérieur et les instances de sous-modules
- **Liste des Signaux** : Après sélection d'un module, afficher tous les signaux de ce module
- **Fonction de Recherche** : Entrer le nom du signal ou du module dans la boîte de recherche pour filtrer

**Méthodes d'Opération :**
- Cliquer sur un module : Afficher les signaux de ce module dans la liste des signaux
- Double-cliquer sur un module : Ouvrir le code source de ce module
- Double-cliquer sur un signal : Ajouter le signal à la fenêtre de formes d'onde actuelle
- Menu contextuel : Plus d'options d'opération

#### 4.3.4 Fenêtre de Code Source

La fenêtre de code source est utilisée pour visualiser le code Verilog/SystemVerilog :

**Fonctions de Base :**
- Coloration syntaxique
- Pliage de code (blocs module, always, begin-end)
- Affichage des numéros de ligne

**Traçage des Pilotes/Charges :**
1. Cliquer sur le nom du signal dans le code
2. Sélectionner "Find Drivers" ou "Find Loads" dans le menu contextuel
3. Les résultats du traçage s'afficheront dans la fenêtre de messages en bas
4. Double-cliquer sur les résultats du traçage pour sauter vers l'emplacement du code source correspondant

**Fonction de Signets :**
- Cliquer sur le menu **Navigate → Add Bookmark** pour ajouter un signet
- Les signets sont affichés dans le panneau de signets à droite
- Double-cliquer sur un signet pour sauter rapidement vers l'emplacement du code correspondant

**Historique de Navigation :**
- Boutons ← → de la barre d'outils pour la navigation avant/arrière
- Support de l'historique de navigation inter-fichiers

**Affichage Développé des Valeurs de Signaux :**
- Cliquer sur l'icône de développement (▶) à gauche de la ligne de code pour développer et afficher toutes les valeurs des signaux sur cette ligne au temps actuel du curseur
- Après développement, le nom du signal, la valeur actuelle, la largeur de bits et d'autres informations sont affichés
- Prend en charge l'affichage multi-base (binaire, hexadécimal, etc.), hérite automatiquement des paramètres de format d'affichage de la fenêtre de formes d'onde
- Cliquer à nouveau sur l'icône de développement pour réduire l'affichage
- L'état de développement est automatiquement sauvegardé et restauré lors du changement d'onglet

#### 4.3.5 Fenêtre de Formes d'Onde

La fenêtre de formes d'onde est utilisée pour visualiser les formes d'onde de simulation :

**Gestion des Signaux :**
- Glisser-déposer les signaux du navigateur de conception vers la fenêtre de formes d'onde
- Double-cliquer sur les signaux dans le navigateur de conception pour les ajouter aux formes d'onde
- Utiliser la fonction de groupement de signaux pour organiser les signaux
- Clic droit sur les signaux pour les supprimer ou les déplacer

**Opérations de Vue :**
- **Zoom** : Molette souris ou boutons +/- de la barre d'outils
- **Panoramique** : Glisser la zone de formes d'onde
- **Plein Écran** : Cliquer sur le bouton "Fit" de la barre d'outils
- **Opération de Curseur** : Cliquer sur la forme d'onde pour définir la position du curseur

**Recherche de Valeurs :**
1. Cliquer sur le bouton "Search" de la barre d'outils
2. Entrer la valeur à rechercher (supporte binaire, hexadécimal, etc.)
3. Les résultats de recherche seront mis en surbrillance

**Affichage du Temps :**
- La barre d'outils affiche le temps de la position actuelle du curseur
- Possibilité d'entrer manuellement une valeur de temps pour sauter vers une position spécifiée

**Support Multi-Fenêtres :**
- Cliquer sur le bouton "+" pour ajouter une nouvelle fenêtre de formes d'onde
- Chaque fenêtre peut afficher différentes combinaisons de signaux
- Support de l'ouverture simultanée de plusieurs fenêtres de code source

#### 4.3.6 Vue Tableau

La vue tableau affiche les valeurs des signaux sous forme de tableau pour une plage de temps spécifique, adaptée à la visualisation et à l'analyse des états des signaux :

**Création de la Vue Tableau :**
- Cliquer sur le bouton "+" dans la barre d'outils et sélectionner "Table" pour créer une nouvelle vue tableau
- Lors de la création d'une vue tableau alors qu'une fenêtre de formes d'onde est active, elle hérite automatiquement de :
  - La plage de temps de la fenêtre de formes d'onde actuelle (View Start / View End)
  - Tous les signaux des groupes développés
  - Le format d'affichage (Radix) de chaque signal
  - Les paramètres de préfixe des signaux

**Gestion des Signaux :**
- Faire glisser les signaux du navigateur de conception vers la vue tableau
- Double-cliquer sur les signaux dans le navigateur de conception pour les ajouter au tableau
- Cliquer sur le bouton "×" dans l'en-tête de colonne pour supprimer le signal
- Faire glisser les en-têtes de colonne pour réorganiser les signaux

**Paramètres de Plage de Temps :**
- Définir la plage de temps dans les zones de saisie "Start" et "Span" de la barre d'outils
- Cliquer sur le bouton "Apply" pour appliquer la nouvelle plage de temps et récupérer les données
- Support de la pagination, utiliser les boutons "Previous" et "Next" pour naviguer
- Cliquer sur le bouton "Continue" pour récupérer plus de données (si disponible)

**Paramètres de Format d'Affichage :**
- Cliquer sur la flèche déroulante dans l'en-tête de colonne pour ouvrir le menu de sélection de format
- Support de l'affichage Binaire (BIN), Octal (OCT), Décimal (DEC), Hexadécimal (HEX)
- Chaque colonne de signal peut être configurée indépendamment

**Filtrage de Métadonnées :**
- Filtrer par caractéristiques des valeurs de signaux : état X, état Z, état mixte, transition, basculement
- Les conditions de filtrage multiples sont combinées avec une logique "OU"

**Filtrage de Colonnes :**
- Saisir les conditions de filtrage dans la zone de saisie de l'en-tête de colonne
- Support du filtrage par valeur hexadécimale (ex : `0x1a`)

#### 4.3.7 Fenêtre de Messages

La fenêtre de messages est située dans le panneau inférieur :

- **Résultats de Traçage des Pilotes** : Afficher les sources de pilotes des signaux
- **Messages Système** : Afficher les résultats d'opérations et les informations d'erreur
- **Saut par Double-Clic** : Double-cliquer sur les résultats de traçage pour sauter vers le code correspondant

#### 4.3.8 Gestion de Session

**Sauvegarder une Session :**
1. Cliquer sur le menu **File → Save Session**
2. Entrer le nom de la session
3. Le contenu sauvegardé inclut :
   - Informations de connexion au serveur
   - Fichiers KDB et de formes d'onde actuellement chargés
   - Toutes les fenêtres de code source ouvertes
   - Toutes les fenêtres de formes d'onde ouvertes (incluant les listes de signaux)
   - Toutes les vues tableau ouvertes (incluant les listes de signaux et les plages de temps)
   - Signets

**Restaurer une Session :**
1. Cliquer sur le menu **File → Restore Session**
2. Sélectionner la session sauvegardée dans la liste
3. Le système effectuera automatiquement :
   - Connexion au serveur
   - Chargement des fichiers KDB et de formes d'onde
   - Restauration de toutes les fenêtres et signets

**Gérer les Sessions :**
- Possibilité de supprimer les sessions indésirables dans la boîte de dialogue de sauvegarde/restauration
- Support de la recherche de sessions sauvegardées
- Les données de session sont stockées dans le LocalStorage du navigateur

#### 4.3.9 Barre de Menu

| Menu | Fonction |
|------|----------|
| **File** | |
| Connect | Se connecter au serveur |
| Disconnect | Se déconnecter du serveur |
| Open KDB | Ouvrir la boîte de dialogue de sélection de fichier KDB |
| Open Waveform | Ouvrir la boîte de dialogue de sélection de fichier de formes d'onde |
| Close KDB | Fermer le KDB actuel |
| Close Waveform | Fermer la forme d'onde actuelle |
| Save Session | Sauvegarder l'état de travail actuel |
| Restore Session | Restaurer l'état de travail sauvegardé |
| **View** | |
| Zoom In | Zoom avant sur la timeline des formes d'onde |
| Zoom Out | Zoom arrière sur la timeline des formes d'onde |
| Zoom Full | Ajuster les formes d'onde à la largeur de la fenêtre |
| **Navigate** | |
| History Back | Naviguer vers l'emplacement de code précédent |
| History Forward | Naviguer vers l'emplacement de code suivant |
| Add Bookmark | Ajouter un signet à l'emplacement actuel |
| Find Driver | Trouver la source du pilote du signal sélectionné (nécessite de sélectionner le signal dans le code) |
| Find Definition | Trouver la définition de l'instance sélectionnée (nécessite de sélectionner l'instance dans le code) |
| **Waveform** | |
| Add Signal | Ajouter un signal à la fenêtre de formes d'onde (nécessite de double-cliquer sur le signal dans le panneau Signaux) |
| Remove Signal | Supprimer le signal de la fenêtre de formes d'onde |
| OPFS Cache | Basculer l'interrupteur de cache OPFS |
| Memory Cache | Basculer l'interrupteur de cache mémoire |
| **Help** | |
| KDB Debug Tool | Ouvrir l'outil de débogage KDB |
| About | Ouvrir la page GitHub du projet |

#### 4.3.9 Barre d'Outils

| Bouton | Fonction |
|--------|----------|
| 🔍+ | Zoom avant sur les formes d'onde |
| 🔍- | Zoom arrière sur les formes d'onde |
| 🔍↔ | Ajuster les formes d'onde à la fenêtre |
| 🔍 | Rechercher une valeur |
| ← | Naviguer en arrière |
| → | Naviguer en avant |
| + | Ajouter un nouvel onglet |
| 📍 | Ajouter un signet |

## FAQ

### Q : La connexion au serveur a échoué ?

1. Confirmer que le Serveur est démarré
2. Vérifier que l'adresse et le port du serveur sont corrects
3. Vérifier les paramètres du pare-feu
4. Consulter la console du navigateur pour les messages d'erreur

### Q : Le chargement des formes d'onde est lent ?

1. Lorsque le fichier de formes d'onde est volumineux, le premier chargement nécessite un téléchargement et une décompression
2. Le système met automatiquement en cache les données chargées
3. Les accès suivants seront plus rapides

### Q : Comment sauvegarder mon état de travail ?

Utiliser la fonction **File → Save Session** pour sauvegarder toutes les fenêtres et paramètres actuels, puis restaurer rapidement via **Restore Session** la prochaine fois.

### Q : Quels navigateurs sont supportés ?

- Chrome 90+
- Firefox 90+
- Safari 15+
- Edge 90+

Nécessite le support de WebGL 2.0 et WebAssembly.

## Problèmes Connus

### Problèmes de Qualité du Code
- **Chaos de la Structure du Code** : Étant principalement généré par l'IA, le code présente des problèmes de répétition et d'organisation. Certaines implémentations de fonctionnalités sont excessivement complexes avec un couplage élevé entre les modules. C'est un problème important que les modèles et chaînes d'outils de programmation par IA actuels doivent continuer à résoudre.

### Problèmes de Performance
- **Consommation Mémoire de l'Interpréteur** : Pour les conceptions volumineuses, l'analyse par l'interpréteur prend beaucoup de temps et consomme trop de mémoire, ce qui peut provoquer des erreurs OOM (Out of Memory). Il est recommandé de traiter les conceptions volumineuses par lots ou d'augmenter la mémoire système.
- **Fluidité du Rendu du Client Web** : Le rendu WebGL2 n'a pas encore été implémenté, seul Canvas2D est utilisé pour le rendu des formes d'onde.

### Complétude des Fonctionnalités
- **Couverture de Test Insuffisante** : De nombreuses fonctionnalités manquent de tests suffisants et peuvent avoir une gestion inadéquate des cas limites. Les contributions communautaires de cas de test et de rapports de bogues sont les bienvenues.

## Ressources Supplémentaires

- **Documentation de Développement du Client Web** : `web-client/README.md`
- **Documentation du Serveur** : `server/README.md`
- **Documentation API** : `server/docs/API.md`

## Licence

MIT License
