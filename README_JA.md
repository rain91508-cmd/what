# WHAT - WebベースHDL解析ツールキット

[中文](README.md) | [English](README_EN.md) | [日本語](README_JA.md) | [Français](README_FR.md) | [Deutsch](README_DE.md) | [Русский](README_RU.md)

WHATは、WebベースのHDL（ハードウェア記述言語）コードおよび波形解析ツールです。

## プロジェクトの動機

このプロジェクトの当初の動機は、AI支援プログラミングの能力をテストすることでした。ハードウェアエンジニアとして、デバッグや解析のためにソースコードとシミュレーション波形を同時に表示する必要がよくあります。しかし、ソースコードと波形を密接に統合できるオープンソースツールは市場に不足しています。商用ツールは高価で柔軟性に欠け、既存のオープンソースソリューションは断片的で完全なワークフローを形成できないことが多いです。

そこで、自分の使用習慣に合った解析ツールをAIを使って開発するというアイデアを思いつきました。驚くべきことに、このプロジェクトの主要なコードはすべてAIによって書かれました。アーキテクチャ設計から具体的な実装まで、インターフェースレイアウトから機能ロジックまで。主要機能の開発には約2週間かかり、その後のバグ修正と機能アーキテクチャの最適化にさらに約2週間かかりました。このような開発効率は従来のプログラミングモデルでは想像できないものであり、AIプログラミング効率の飛躍的な向上を十分に示しています。

特に感謝したいのは：
- **Trae IDE** - 優れた開発環境と無料のAIコンピューティングパワーサポートを提供
- **Doubao-seed-2.0**、**Kimi K2.5**、**GLM-5** などの大規模モデル - 強力なコード生成能力を提供

## 機能特徴

### ソースコード解析
- **Verilog/SystemVerilogサポート**：完全なシンタックスハイライトとコード折りたたみ
- **設計階層ブラウジング**：モジュールインスタンス化階層の視覚的表示
- **スマートコードナビゲーション**：定義ジャンプ、ドライバー追跡、ロード追跡をサポート
- **ブックマーク機能**：重要なコード位置を素早くマークしてジャンプ
- **ナビゲーション履歴**：コード位置の前進/後退ブラウジングをサポート

### 波形解析
- **FST波形ファイルサポート**：大規模波形ファイルの高性能読み取り
- **マルチシグナル表示**：シグナルグループ管理とカスタム列幅をサポート
- **柔軟なズームとパン**：マウスホイールズーム、ドラッグパン、フルスクリーン適合
- **カーソル操作**：カーソル位置をクリックして設定し、シグナル値を正確に表示
- **値検索機能**：バイナリ、16進数、8進数などのフォーマットパターン検索をサポート
- **検索履歴**：検索履歴を保存して素早く繰り返し検索

### 統合機能
- **ソース-波形連動**：コード内のシグナルをダブルクリックしてドライバーソースを表示
- **設計ブラウザ**：モジュール階層ツリーから波形ウィンドウへのシグナル迅速追加
- **セッション管理**：完全な作業状態の保存と復元
- **マルチタブサポート**：複数のソースコードウィンドウと波形ウィンドウを同時に開く

## システムアーキテクチャ

```
┌─────────────────────────────────────────────────────────────────┐
│                     ユーザーワークフロー                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   Verilog/SVソースファイル                                       │
│        │                                                        │
│        ↓                                                        │
│   ┌─────────────┐                                               │
│   │ インタプリタ │  → KDBファイル（ナレッジデータベース）生成    │
│   └─────────────┘                                               │
│        │                                                        │
│        ↓                                                        │
│   ┌─────────────┐     ┌─────────────┐                          │
│   │   サーバー   │ ←→  │ Webクライアント│                        │
│   │  （バックエンド）│     │  （ブラウザ）  │                        │
│   └─────────────┘     └─────────────┘                          │
│        │                     │                                  │
│        ↓                     ↓                                  │
│   KDBファイル           ユーザーインターフェース                  │
│   波形ファイル（FST）    - コードビューア                         │
│                         - 波形ビューア                           │
│                         - 設計ブラウザ                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## システム構成

| コンポーネント | ディレクトリ | 機能 |
|--------------|-------------|------|
| インタプリタ | `interpreter/` | Verilog/SVソースコードを解析し、KDBナレッジデータベースを生成 |
| サーバー | `server/` | HTTP APIを提供し、KDBおよび波形ファイルをサービス |
| Webクライアント | `web-client/` | ブラウザフロントエンドインターフェース、コードおよび波形表示 |

## クイックスタート

### 要件

- **Node.js** 18+（Webクライアント用）
- **Rust**（サーバー用）
- **CMake** + **C++コンパイラ**（インタプリタ用）
- **Surelog**（インタプリタ用、SystemVerilog解析）

### 起動手順

1. **サーバーを起動**
   ```bash
   cd server
   cargo run --release -- --kdb-dir /path/to/kdb --wave-dir /path/to/waves --port 8080
   ```

2. **Webクライアントを起動**
   ```bash
   cd web-client
   npm install
   npm run dev
   ```

3. **インターフェースにアクセス**
   
   ブラウザを開いて `http://localhost:3000` にアクセス

## ユーザーガイド

### 4.1 インタプリタ

インタプリタは、Verilog/SystemVerilogソースコードを解析してKDB（ナレッジデータベース）ファイルを生成するために使用されます。KDBファイルには以下が含まれます：
- モジュール定義とインスタンス化階層
- シグナル宣言と接続関係
- ドライバー/ロード追跡情報

#### 4.1.1 要件

- **Ubuntu 22.04+** または **WSL2 (Ubuntu)**
- **CMake** 3.20+
- **GCC/G++** 11+ または **Clang** 14+
- **Protocol Buffers** (protobuf)
- **zstd**（オプション、圧縮用）

#### 4.1.2 依存関係のインストール

Ubuntu/WSLでコンパイル依存関係をインストール：

```bash
# パッケージリストを更新
sudo apt-get update

# 基本コンパイルツールをインストール
sudo apt-get install -y build-essential cmake git

# Protocol Buffersをインストール
sudo apt-get install -y protobuf-compiler libprotobuf-dev

# zstdをインストール（オプション、圧縮用）
sudo apt-get install -y libzstd-dev

# その他の依存関係をインストール
sudo apt-get install -y python3 python3-pip pkg-config
```

#### 4.1.3 コンパイル

**ステップ1：リポジトリをクローン**
```bash
cd /path/to/your/workspace
git clone <repository-url>
cd webhwd
```

**ステップ2：依存関係をインストール**
```bash
# パッケージリストを更新
sudo apt-get update

# 基本コンパイルツールをインストール
sudo apt-get install -y build-essential cmake git

# Protocol Buffersをインストール
sudo apt-get install -y protobuf-compiler libprotobuf-dev

# zstdをインストール（オプション、圧縮用）
sudo apt-get install -y libzstd-dev
```

**ステップ3：プロジェクトをコンパイル**
```bash
# コンパイルスクリプトを実行
./build.sh
```

コンパイルの注意事項：
- コンパイルスクリプトは自動的にSurelog（SystemVerilogパーサー）をダウンロードしてコンパイルします
- 初回コンパイルには10-20分かかる場合があります（マシンの性能によります）
- コンパイル結果はキャッシュされ、後続のコンパイルはより高速になります
- コンパイル後、実行ファイルは以下に配置されます：
  - `build_new/interpreter/hwda_interpreter`
  - `build_new/interpreter/kdb_viewer`

**ステップ4：インストールを確認**
```bash
# インタプリタが利用可能か確認
./build_new/interpreter/hwda_interpreter --help

# kdb_viewerが利用可能か確認
./build_new/interpreter/kdb_viewer --help
```

#### 4.1.4 基本使用方法

**Verilogファイルを解析してKDBを生成：**

```bash
# 基本使用方法
./build_new/interpreter/hwda_interpreter design.v --output design.kdb

# トップモジュールを指定
./build_new/interpreter/hwda_interpreter design.v --output design.kdb -top top_module

# インクルードパスを追加
./build_new/interpreter/hwda_interpreter design.v --output design.kdb +incdir+./include

# 詳細ログを表示する詳細モードを使用
./build_new/interpreter/hwda_interpreter design.v --output design.kdb --verbose
```

**一般的なオプション：**

| オプション | 説明 |
|-----------|------|
| `-o, --output <path>` | 出力KDBファイルパスを指定（デフォルト：design.kdb） |
| `-top <module>` | トップモジュールを指定 |
| `+incdir+<dir>` | インクルードパスを追加 |
| `-y <path>` | ライブラリディレクトリを追加 |
| `-v <file>` | ライブラリファイルを追加 |
| `-D<name>=<value>` | マクロを定義 |
| `-z, --compress` | 圧縮を有効化（デフォルトで有効） |
| `-Z, --no-compress` | 圧縮を無効化 |
| `-V, --verbose` | 詳細なデバッグ情報を表示 |
| `-h, --help` | ヘルプ情報を表示 |

#### 4.1.5 KDBファイルの表示

kdb_viewerツールを使用して生成されたKDBファイルの内容を表示：

```bash
# KDBファイル情報を表示
./build_new/interpreter/kdb_viewer design.kdb

# すべてのモジュールをリスト
./build_new/interpreter/kdb_viewer design.kdb --modules

# すべてのシグナルをリスト
./build_new/interpreter/kdb_viewer design.kdb --signals

# 特定のシグナルのドライバー情報を表示
./build_new/interpreter/kdb_viewer design.kdb --driver work@top.signal_name

# JSON形式で出力
./build_new/interpreter/kdb_viewer design.kdb --json
```

#### 4.1.6 KDBファイル形式

KDB（ナレッジデータベース）は、以下を含むカスタムバイナリ形式です：

- **モジュール情報**：モジュール定義、インスタンス化階層、パラメータ
- **シグナル情報**：シグナル宣言、ビット幅、タイプ（wire/reg/parameterなど）
- **接続関係**：シグナルのドライバーとロード情報
- **ソースコード位置**：ソースコードにジャンプするためのファイル名、行番号

KDBファイルはProtocol Buffersシリアライゼーションを使用し、オプションでzstd圧縮を使用します。

#### 4.1.7 使用例

```bash
# Verilogファイルを解析してKDBを生成
./build_new/interpreter/hwda_interpreter tests/simple.v --output tests/simple.kdb

# 生成されたKDBファイル情報を表示
./build_new/interpreter/kdb_viewer tests/simple.kdb

# 特定のシグナルのドライバー情報を表示
./build_new/interpreter/kdb_viewer tests/simple.kdb --driver work@top.sum
```

詳細な使用説明については、`interpreter/README.md`を参照してください。

### 4.2 サーバー

サーバーは以下のためのHTTP APIを提供します：
- KDBファイルのサービス
- 波形ファイル（FST形式）のサービス
- シグナル検索およびクエリインターフェースの提供
- 2つのFST読み取りバックエンドのサポート：fstapi（デフォルト）とfst-reader

#### 4.2.1 要件

**Windows：**
- **Rust** 1.70+（rustup経由でインストール）
- **LLVM/Clang**（fst-readerバックエンドbindgen用）
- **vcpkg**（C++依存関係管理用）

**Ubuntu/WSL：**
- **Rust** 1.70+ 
- **LLVM/Clang** 
- **pkg-config**
- **libzstd-dev**（オプション、圧縮用）

#### 4.2.2 Windowsコンパイル手順

1. **Rustをインストール**
   ```powershell
   # rustup経由でインストール
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   # または https://rustup.rs/ からインストーラーをダウンロード
   ```

2. **LLVM/Clangをインストール**
   - https://github.com/llvm/llvm-project/releases からLLVMをダウンロード
   - `C:\Users\<username>\Downloads\clang+llvm-<version>-x86_64-pc-windows-msvc` に展開
   - 環境変数を設定：`LIBCLANG_PATH=C:\path\to\llvm\bin`

3. **vcpkgをインストール**
   ```powershell
   git clone https://github.com/Microsoft/vcpkg.git C:\path\to\vcpkg
   cd C:\path\to\vcpkg
   .\bootstrap-vcpkg.bat
   ```

4. **サーバーをコンパイル**
   ```powershell
   cd server
   $env:VCPKG_ROOT="C:\path\to\vcpkg"
   $env:LIBCLANG_PATH="C:\path\to\llvm\bin"
   cargo build --release
   ```
   
   コンパイル後、実行ファイルは以下に配置されます：`target\release\hwda-server.exe`

#### 4.2.3 Ubuntu/WSLコンパイル手順

1. **依存関係をインストール**
   ```bash
   sudo apt-get update
   sudo apt-get install -y build-essential pkg-config libzstd-dev
   
   # Rustをインストール
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   source $HOME/.cargo/env
   
   # LLVM/Clangをインストール
   sudo apt-get install -y llvm libclang-dev
   ```

2. **サーバーをコンパイル**
   ```bash
   cd server
   cargo build --release
   ```
   
   コンパイル後、実行ファイルは以下に配置されます：`target/release/hwda-server`

#### 4.2.4 基本使用方法

**サーバーを起動：**

```bash
# 基本使用方法（デフォルトのfstapiバックエンドを使用）
./hwda-server --kdb-dir /path/to/kdb --wave-dir /path/to/waves --port 8080

# fst-readerバックエンドを使用
./hwda-server --kdb-dir /path/to/kdb --wave-dir /path/to/waves --fst-backend fst-reader

# 詳細なデバッグログを有効化
./hwda-server --kdb-dir /path/to/kdb --wave-dir /path/to/waves --log-level debug --verbose

# 起動時にキャッシュをクリア
./hwda-server --kdb-dir /path/to/kdb --wave-dir /path/to/waves --clear-cache-on-startup

# Webクライアント静的ファイルサービスを有効化
./hwda-server --kdb-dir /path/to/kdb --wave-dir /path/to/waves --web-dir /path/to/web-client/dist
```

**一般的なオプション：**

| オプション | 説明 | デフォルト |
|-----------|------|----------|
| `--kdb-dir <path>` | KDBファイルディレクトリ | `./kdb` |
| `--wave-dir <path>` | 波形ファイルディレクトリ | `./waves` |
| `--port <port>` | サービスポート | `8080` |
| `--host <host>` | バインドアドレス | `0.0.0.0` |
| `--fst-backend <backend>` | FST読み取りバックエンド（`fstapi` または `fst-reader`） | `fstapi` |
| `--log-level <level>` | ログレベル（`trace`, `debug`, `info`, `warn`, `error`） | `info` |
| `--verbose` | 詳細なデバッグ出力を有効化（`log-level=debug`時のみ有効） | `false` |
| `--web-dir <path>` | Webクライアント静的ファイルディレクトリ | - |
| `--clear-cache-on-startup` | 起動時にすべてのキャッシュをクリア | `false` |
| `--enable-cors` | CORSを有効化 | `true` |
| `--cache-capacity-mb <size>` | LRUキャッシュ容量（MB） | `512` |

**ヘルプを表示：**

```bash
./hwda-server --help
```

#### 4.2.5 FSTバックエンド選択

サーバーは2つのFST読み取りバックエンドをサポートします：

1. **fstapi**（デフォルト）
   - GTKWaveのlibfst Cライブラリを使用
   - 互換性が良く、すべてのFST機能をサポート
   - C++コンパイル環境が必要

2. **fst-reader**（純粋Rust）
   - 純粋Rust実装、C++依存関係なし
   - より良い性能、より低いメモリ使用量
   - `--fst-backend fst-reader`で有効化

**バックエンド切り替え例：**
```bash
# fstapiバックエンドを使用（デフォルト）
./hwda-server --wave-dir ./waves

# fst-readerバックエンドを使用
./hwda-server --wave-dir ./waves --fst-backend fst-reader
```

#### 4.2.6 APIインターフェース

サーバーは以下の主要なAPIを提供します：

- `GET /api/kdb` - すべてのKDBファイルをリスト
- `GET /api/kdb/{name}/signals` - KDB内のシグナルリストを取得
- `GET /api/wave` - すべての波形ファイルをリスト
- `GET /api/wave/{name}/signals` - 波形ファイル内のシグナルリストを取得
- `GET /api/wave/{name}/lod/{lod}/tile/{start}/{span}/{count}/signals/{signal_ids}/data` - 波形データを取得

詳細なAPIドキュメントについては、`server/API.md`を参照してください。

### 4.3 Webクライアント

#### 4.3.1 サーバーに接続

アプリケーションを初めて開くときは、サーバーに接続する必要があります：

1. 接続ダイアログでサーバーアドレスとポートを入力
2. デフォルトアドレスは `localhost:8080`
3. 「Connect」ボタンをクリック
4. 接続成功後、利用可能なKDBファイルリストが自動的に表示されます

#### 4.3.2 KDBおよび波形ファイルを読み込む

**KDBファイルを読み込む：**
1. メニュー **File → Open KDB** をクリック
2. リストからKDBファイルを選択
3. 読み込み後、左の設計ブラウザにモジュール階層が表示されます

**波形ファイルを読み込む：**
1. メニュー **File → Open Waveform** をクリック
2. リストから波形ファイル（FST形式）を選択
3. または「Use Mock Data」を選択してテスト用のシミュレーションデータを使用

#### 4.3.3 設計ブラウザ

設計ブラウザは左パネルにあり、設計階層を表示します：

- **モジュールツリー**：トップレベルモジュールとサブモジュールインスタンスを表示
- **シグナルリスト**：モジュールを選択後、そのモジュールのすべてのシグナルを表示
- **検索機能**：検索ボックスにシグナル名またはモジュール名を入力してフィルタ

**操作方法：**
- モジュールをクリック：シグナルリストにそのモジュールのシグナルを表示
- モジュールをダブルクリック：そのモジュールのソースコードを開く
- シグナルをダブルクリック：シグナルを現在の波形ウィンドウに追加
- 右クリックメニュー：その他の操作オプション

#### 4.3.4 ソースコードウィンドウ

ソースコードウィンドウは、Verilog/SystemVerilogコードを表示するために使用されます：

**基本機能：**
- シンタックスハイライト
- コード折りたたみ（module、always、begin-endブロック）
- 行番号表示

**ドライバー/ロード追跡：**
1. コード内のシグナル名をクリック
2. ポップアップメニューで「Find Drivers」または「Find Loads」を選択
3. 追跡結果が下部のメッセージウィンドウに表示されます
4. 追跡結果をダブルクリックして対応するソースコード位置にジャンプ

**ブックマーク機能：**
- メニュー **Navigate → Add Bookmark** をクリックしてブックマークを追加
- ブックマークは右側のブックマークパネルに表示されます
- ブックマークをダブルクリックして対応するコード位置に素早くジャンプ

**ナビゲーション履歴：**
- ツールバーの ← → ボタンで前進/後退ナビゲーション
- クロスファイルナビゲーション履歴をサポート

#### 4.3.5 波形ウィンドウ

波形ウィンドウは、シミュレーション波形を表示するために使用されます：

**シグナル管理：**
- 設計ブラウザから波形ウィンドウにシグナルをドラッグ
- 設計ブラウザ内のシグナルをダブルクリックして波形に追加
- シグナルグループ機能を使用してシグナルを整理
- シグナルを右クリックして削除または移動

**ビュー操作：**
- **ズーム**：マウスホイールまたはツールバーの +/- ボタン
- **パン**：波形エリアをドラッグ
- **フルスクリーン**：ツールバーの「Fit」ボタンをクリック
- **カーソル操作**：波形をクリックしてカーソル位置を設定

**値検索：**
1. ツールバーの「Search」ボタンをクリック
2. 検索する値を入力（バイナリ、16進数などをサポート）
3. 検索結果がハイライト表示されます

**時間表示：**
- ツールバーに現在のカーソル位置の時間を表示
- 手動で時間値を入力して指定位置にジャンプ可能

**マルチウィンドウサポート：**
- 「+」ボタンをクリックして新しい波形ウィンドウを追加
- 各ウィンドウは異なるシグナル組み合わせを表示可能
- 複数のソースコードウィンドウを同時に開くことをサポート

#### 4.3.6 メッセージウィンドウ

メッセージウィンドウは下部パネルにあります：

- **ドライバー追跡結果**：シグナルのドライバーソースを表示
- **システムメッセージ**：操作結果とエラー情報を表示
- **ダブルクリックジャンプ**：追跡結果をダブルクリックして対応するコードにジャンプ

#### 4.3.7 セッション管理

**セッションを保存：**
1. メニュー **File → Save Session** をクリック
2. セッション名を入力
3. 保存内容には以下が含まれます：
   - サーバー接続情報
   - 現在読み込まれているKDBおよび波形ファイル
   - 開いているすべてのソースコードウィンドウ
   - 開いているすべての波形ウィンドウ（シグナルリストを含む）
   - ブックマーク

**セッションを復元：**
1. メニュー **File → Restore Session** をクリック
2. リストから保存されたセッションを選択
3. システムは自動的に以下を行います：
   - サーバーに接続
   - KDBおよび波形ファイルを読み込む
   - すべてのウィンドウとブックマークを復元

**セッションを管理：**
- 保存/復元ダイアログで不要なセッションを削除可能
- 保存されたセッションの検索をサポート
- セッションデータはブラウザのLocalStorageに保存されます

#### 4.3.8 メニューバー

| メニュー | 機能 |
|---------|------|
| **File** | |
| Connect | サーバーに接続 |
| Disconnect | サーバーから切断 |
| Open KDB | KDBファイル選択ダイアログを開く |
| Open Waveform | 波形ファイル選択ダイアログを開く |
| Close KDB | 現在のKDBを閉じる |
| Close Waveform | 現在の波形を閉じる |
| Save Session | 現在の作業状態を保存 |
| Restore Session | 保存された作業状態を復元 |
| **View** | |
| Zoom In | 波形タイムラインを拡大 |
| Zoom Out | 波形タイムラインを縮小 |
| Zoom Full | 波形をウィンドウ幅に適合 |
| **Navigate** | |
| History Back | 前のコード位置にナビゲート |
| History Forward | 次のコード位置にナビゲート |
| Add Bookmark | 現在の位置にブックマークを追加 |
| Find Driver | 選択されたシグナルのドライバーソースを検索（コード内でシグナルを選択する必要があります） |
| Find Definition | 選択されたインスタンスの定義を検索（コード内でインスタンスを選択する必要があります） |
| **Waveform** | |
| Add Signal | 波形ウィンドウにシグナルを追加（Signal Panelでシグナルをダブルクリックする必要があります） |
| Remove Signal | 波形ウィンドウからシグナルを削除 |
| OPFS Cache | OPFSキャッシュスイッチを切り替え |
| Memory Cache | メモリキャッシュスイッチを切り替え |
| **Help** | |
| KDB Debug Tool | KDBデバッグツールを開く |
| About | プロジェクトGitHubページを開く |

#### 4.3.9 ツールバー

| ボタン | 機能 |
|--------|------|
| 🔍+ | 波形を拡大 |
| 🔍- | 波形を縮小 |
| 🔍↔ | 波形をウィンドウに適合 |
| 🔍 | 値を検索 |
| ← | 後退ナビゲート |
| → | 前進ナビゲート |
| + | 新しいタブを追加 |
| 📍 | ブックマークを追加 |

## FAQ

### Q: サーバーへの接続に失敗しましたか？

1. サーバーが起動していることを確認
2. サーバーアドレスとポートが正しいか確認
3. ファイアウォール設定を確認
4. ブラウザコンソールでエラーメッセージを確認

### Q: 波形の読み込みが遅いですか？

1. 波形ファイルが大きい場合、初回読み込みにはダウンロードと解凍が必要です
2. システムは自動的に読み込まれたデータをキャッシュします
3. 後続のアクセスはより高速になります

### Q: 作業状態を保存するにはどうすればよいですか？

**File → Save Session** 機能を使用して、現在のすべてのウィンドウと設定を保存し、次回 **Restore Session** で素早く復元します。

### Q: どのブラウザがサポートされていますか？

- Chrome 90+
- Firefox 90+
- Safari 15+
- Edge 90+

WebGL 2.0およびWebAssemblyのサポートが必要です。

## 既知の問題

### コード品質の問題
- **コード構造の混乱**：主にAIによって生成されたため、コードには繰り返しと組織化の問題があります。一部の機能実装は過度に複雑で、モジュール間の結合度が高いです。これは現在のAIプログラミングモデルとツールチェーンが引き続き解決する必要がある重要な問題です。

### パフォーマンスの問題
- **インタプリタのメモリ消費**：大規模な設計の場合、インタプリタの解析に時間がかかり、メモリを消費しすぎるため、OOM（Out of Memory）エラーが発生する可能性があります。大規模な設計をバッチ処理するか、システムメモリを増やすことをお勧めします。
- **Webクライアントのレンダリングスムーズさ**：WebGL2レンダリングはまだ実装されておらず、波形レンダリングにはCanvas2Dのみを使用しています。

### 機能の完全性
- **テストカバレッジの不足**：多くの機能に十分なテストがなく、境界ケースの処理が不適切な可能性があります。テストケースとバグレポートのコミュニティ貢献を歓迎します。

## その他のリソース

- **Webクライアント開発ドキュメント**：`web-client/README.md`
- **サーバードキュメント**：`server/README.md`
- **APIドキュメント**：`server/docs/API.md`

## ライセンス

MIT License
