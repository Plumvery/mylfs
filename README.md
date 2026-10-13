# mylfs

**Git LFS の代わりに、大きなファイルを自分のストレージ（Cloudflare R2 / S3 互換 / Google Drive / ローカルフォルダ）に置く CLI。**

[UniLFS](https://github.com/Plumvery/UniLFS)（Unity エディタ拡張）の仕組みを Node.js に移植し、Unity 以外のどんな git プロジェクトでも使えるようにしたものです。依存パッケージはゼロ、Node.js 18 以上で動きます。

- git には小さな `unilfs.manifest.json`（パス + SHA-256 + サイズ）だけが入り、実ファイルは gitignore されて外部ストレージへ
- **UniLFS とファイル形式が完全互換** — Unity プロジェクトでは Unity パッケージと mylfs を同じチェックアウトで併用できる
- Unity の Auto Pull / Auto Push の代わりに **git フック**で自動同期

## 仕組み

```
your-project/
├── unilfs.manifest.json   ← git にコミット（パス + sha256 + size）
├── unilfs.track           ← git にコミット（どのファイルを外部に置くかのパターン）
├── unilfs.config.json     ← git にコミット（プロバイダ・バケット等。秘密情報は入れない）
├── unilfs.staged.json     ← コミットしない：track 済み・未 push のパス
├── .gitignore             ← UniLFS 管理ブロックを自動で維持
├── art/hero.psd           ← gitignore され、ストレージから復元される
└── .unilfs/               ← コミットしない：認証情報とキャッシュ
    ├── credentials.json
    └── cache/

ストレージ:  <prefix>/objects/ab/abcdef1234...   ← SHA-256 名のブロブ（重複排除）
```

> ファイル名（`unilfs.*`、`.unilfs/`）・環境変数（`UNILFS_*`）・`.gitignore` のマーカーは UniLFS と共通のままにしています。これを変えると Unity パッケージとの互換性が失われるためです。

1. **track** — ファイルを「ステージ」し、`.git/info/exclude` で即座に git から隠す。マニフェストはまだ書かない
2. **push** — ストレージに無いブロブをアップロードし、**アップロードが確認できてから**マニフェストに記録。コミットされたマニフェストが存在しないブロブを指すことは起きない
3. **pull** — マニフェストにあってローカルに無い／古いファイルをダウンロードし、ハッシュ検証してから配置

「自分が編集した（modified）」と「他人が新しい版を push した（outdated）」は、このマシンが最後に同期したハッシュ（ベースライン）と比べる三者比較で区別します。両方動いた場合は **conflicted** となり、勝手にどちらかで上書きはしません。

## インストール

```bash
npm install -g github:Plumvery/mylfs
```

（clone して `npm link` でも可）

## クイックスタート（Cloudflare R2）

```bash
cd your-project
mylfs init --provider s3 --endpoint https://<account-id>.r2.cloudflarestorage.com --bucket my-bucket
mylfs login          # Access Key ID / Secret を入力（.unilfs/credentials.json に保存、git には入らない）
mylfs test           # 接続確認
```

`unilfs.track` にパターンを書いて track → push：

```
*.psd
*.mp4
assets/movies/
!assets/ui/*.psd
```

```bash
mylfs track          # 引数なし = unilfs.track に一致する全ファイル。ファイル/フォルダを直接指定も可
mylfs push
git add unilfs.manifest.json unilfs.track unilfs.config.json .gitignore
git commit -m "Move large assets to R2"
mylfs hooks install  # checkout / merge 後に自動 pull、push 前にブロブの存在を検証
```

チームメイトは clone → `mylfs login` → `mylfs pull`（フックを入れておけば以降の `git pull` / ブランチ切替で自動）。

### 他のストレージ

```bash
# Google Drive（OAuth の「デスクトップアプリ」クライアントを用意）
mylfs init --provider googledrive --client-id <id> --client-secret <secret> --folder-id <folder-id>
mylfs login          # ブラウザで Google にサインイン。folder-id 未設定ならフォルダ作成も提案

# ローカル / NAS / 同期フォルダ
mylfs init --provider local --local-path //nas/share/unilfs
```

Google Drive クライアントの作り方は UniLFS の [setup-google-drive.md](https://github.com/Plumvery/UniLFS/blob/main/Documentation~/setup-google-drive.md)、R2 のトークン作成は [setup-r2.md](https://github.com/Plumvery/UniLFS/blob/main/Documentation~/setup-r2.md) を参照。

## コマンド

| コマンド | 内容 |
|---|---|
| `mylfs init [--provider ...]` | 設定ファイル・`unilfs.track` テンプレート・`.gitignore` ブロックを作成 |
| `mylfs config [list \| get <key> \| set <key> <value>]` | 設定の表示・変更 |
| `mylfs login` / `logout` | このマシンの認証情報を保存 / 消去 |
| `mylfs test` | ストレージ接続テスト |
| `mylfs track [paths...]` | ステージ（引数なしで `unilfs.track` に一致する全ファイル） |
| `mylfs untrack <paths...>` | 追跡解除（ファイルは残る） |
| `mylfs push [--require-baseline]` | 新規/変更ファイルをアップロードしてマニフェストに記録 |
| `mylfs pull [--restore-modified]` | 不足/古いファイルをダウンロード（`--restore-modified` でローカル変更も上書き） |
| `mylfs status [--verify] [--json]` | 全追跡ファイルの状態（`--verify` でストレージにも問い合わせ） |
| `mylfs verify` | マニフェストが指すブロブがストレージに無ければ失敗（CI 用） |
| `mylfs keep-mine <paths...>` | 競合を「自分の版」で解決（次の push でアップロード） |
| `mylfs hooks install [--pre-commit]` / `uninstall` / `status` | git フックの管理 |

共通オプション: `--root <dir>`（プロジェクトルートを明示）、`--quiet`。Ctrl+C で中断すると、完了済みのファイルはマニフェストに記録してから終了します。

状態表示: **staged**（track 済み・未 push）/ **up to date** / **not pushed**（マニフェストと一致するがこのマシンはアップロードを確認していない。`status --verify` で確認）/ **modified** / **outdated** / **conflicted** / **missing**

## git フック（Unity の Auto Sync の代わり）

`mylfs hooks install` で以下を入れます（既存のフックは壊さず、マーカー付きブロックを追記）。`core.hooksPath`（husky 等）も尊重します。

| フック | 動作 |
|---|---|
| `post-checkout`, `post-merge` | 新しいマニフェストに合わせて pull（失敗しても git 操作は止めない） |
| `pre-push` | **push しようとしているコミット**のマニフェストが指すブロブが全部ストレージにあるか検証し、無ければ push を中止 |
| `pre-commit`（`--pre-commit` 指定時のみ） | コミット前に push し、更新されたマニフェストと `.gitignore` を自動で `git add` |

`pre-commit` の注意: 変更が gitignore 済みの大きいファイル**だけ**の場合、git は「コミットするものが無い」と判断して止まります（フックがマニフェストをステージ済みなので、もう一度 `git commit` すれば通ります）。

## CI

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with: { node-version: 22 }
- run: npm install -g github:Plumvery/mylfs
- run: mylfs pull                 # ビルド前に実ファイルを取得（読み取り専用トークンで可）
  env:
    UNILFS_S3_ACCESS_KEY_ID: ${{ secrets.UNILFS_S3_ACCESS_KEY_ID }}
    UNILFS_S3_SECRET_ACCESS_KEY: ${{ secrets.UNILFS_S3_SECRET_ACCESS_KEY }}
```

`mylfs verify` はローカルファイル不要で、マニフェストに存在しないブロブがあれば非ゼロ終了します（PR のゲートに）。

環境変数（ファイルより優先）: `UNILFS_S3_ACCESS_KEY_ID`, `UNILFS_S3_SECRET_ACCESS_KEY`, `UNILFS_DRIVE_CLIENT_ID`, `UNILFS_DRIVE_CLIENT_SECRET`, `UNILFS_DRIVE_REFRESH_TOKEN`, `UNILFS_PULL_RESTORE_MODIFIED=1`

## Unity プロジェクトで使う場合

`ProjectSettings/ProjectVersion.txt` か `ProjectSettings/UniLFSSettings.json` があると自動で **Unity モード**になり、UniLFS パッケージと同じ場所を使います。

| | 汎用モード | Unity モード |
|---|---|---|
| 設定 | `unilfs.config.json` | `ProjectSettings/UniLFSSettings.json` |
| 認証情報 | `.unilfs/credentials.json` | `UserSettings/UniLFS.json` |
| キャッシュ | `.unilfs/cache/` | `Library/UniLFS/`（エディタと共有） |
| 追跡不可 | `.git/`, `.unilfs/`, `excludeDirs`（既定 `node_modules`） | `.meta`, `Library/`, `Temp/`, `Logs/`, `obj/`, `UserSettings/`, `.git/` |

マニフェスト・`unilfs.staged.json`・`.gitignore` 管理ブロック・`.git/info/exclude` ブロック・状態キャッシュ・ストレージのキー配置はすべて UniLFS と同一なので、Unity を持っていないメンバー（CI、デザイナー、サーバー）が mylfs で pull / push でき、Unity 側と差分が出ません。Unity モードでは push 時に `.meta` の GUID をマニフェストに記録し、pull 時に消えた `.meta` を復元します。

注意:
- **Unity エディタが push/pull している最中に mylfs を同じチェックアウトで動かさないでください**（UniLFS のロックはエディタ内だけのもの）。
- `local` プロバイダは mylfs 独自の機能で、Unity パッケージは S3 と Google Drive しか読めません。

## ライブラリとして使う

```js
import { findProject, track, push, pull, status } from 'mylfs';

const project = findProject(process.cwd());
await track(project, ['art/hero.psd']);
const result = await push(project, { onProgress: (ev) => console.log(ev) });
```

`push` / `pull` / `verify` / `status` には `provider` オプションで独自のストレージ実装（`blobExists` / `uploadBlob` / `downloadBlob` / `testConnection` を持つオブジェクト）を渡せます。

## 他のツールから呼ぶ（`--json`）

UniLFS の Unity パッケージはこのインターフェース経由で mylfs を呼んでいます。

| オプション | 内容 |
|---|---|
| `--json` | stdout に結果の JSON を 1 つだけ出す。失敗時は `{"error": {"kind": "config\|busy\|cancelled\|error", "message"}}` |
| `--progress-json` | stderr に進捗イベントを 1 行 1 JSON で出す（`phase` は全体の中での `start`/`span` を持つ） |
| `--cancel-on-stdin` | stdin に `cancel` 行が来たら安全に中断（完了分はマニフェストに記録） |
| `--paths-file <file>` | パスを 1 行 1 つでファイルから読む（相対パスはプロジェクトルート基準） |

`--json` 専用コマンド: `patterns`（パターン数とエラー）、`refresh-ignore`、`drive-create-folder [name]`、`version`。`track --matching <paths>` は渡したパスのうち `unilfs.track` に一致するものだけをステージします。

## 制限

- ファイルロック無し（git と同様、共有バイナリの編集は調整してください）
- 古いブロブの GC 無し
- S3 は単一リクエストのアップロードのため 1 オブジェクト約 5 GB まで
- 同時に複数プロセスが同じプロジェクトを操作するのはロックで拒否（死んだプロセスのロックは自動回収）

## 開発

```bash
npm test     # node:test、依存なし（フォーマット互換・SigV4 の AWS テストベクタ・同期シナリオ・S3 往復）
```

## ライセンス

[MIT](LICENSE) © 2026 Plumvery
