# local-comfy-ui

Docker Compose でローカルに ComfyUI を立ち上げるための構成です。

## 前提

- NVIDIA GPU + ドライバ
- Docker / Docker Compose v2
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)

## 使い方

```sh
docker compose up -d
```

初回はイメージのビルド（ComfyUI の clone と依存パッケージのインストール）が走るため数分かかります。
起動後、ブラウザで http://localhost:8188 を開いてください。

停止・ログ確認:

```sh
docker compose logs -f
docker compose down
```

## ディレクトリ構成

ホストの `data/` 以下がコンテナ内の ComfyUI にマウントされます。

| ホスト | コンテナ | 用途 |
| --- | --- | --- |
| `data/models` | `/opt/comfyui/models` | チェックポイント・VAE・LoRA などのモデル |
| `data/input` | `/opt/comfyui/input` | 入力画像 |
| `data/output` | `/opt/comfyui/output` | 生成結果 |
| `data/user` | `/opt/comfyui/user` | ワークフロー・設定 |
| `data/custom_nodes` | `/opt/comfyui/custom_nodes` | カスタムノード |
| `custom_nodes/danbooru_tag_composer` | `/opt/comfyui/custom_nodes/danbooru_tag_composer` | 自作のカスタムノード（後述） |

モデルは `data/models/checkpoints/` などに配置してください。`checkpoints` / `loras` / `vae` といった標準サブディレクトリは、コンテナ起動時に `entrypoint.sh` が作成します。

コンテナはホストと同じ uid/gid で動くため、生成された画像やワークフローはホスト側で自分の所有になります。

Hugging Face のキャッシュ (`~/.cache`) と追加インストールした Python パッケージ (`~/.local`) は名前付きボリューム `comfy-home` に保存され、コンテナを作り直しても残ります。

## 設定

`.env.example` を `.env` にコピーして編集します。

- `COMFYUI_PORT` — ホスト側の公開ポート（既定 `8188`）
- `COMFYUI_BIND` — ホスト側の bind アドレス（既定 `127.0.0.1`）。LAN の他マシンから使いたい場合のみ `0.0.0.0` などに広げます
- `COMFYUI_VERSION` — 取得する ComfyUI のリビジョン（既定 `master`）
- `COMFYUI_ENABLE_MANAGER` — ComfyUI-Manager を有効にするか（既定 `1`）
- `COMFYUI_UID` / `COMFYUI_GID` — コンテナの実行ユーザー（既定 `1000`）。`id -u` / `id -g` が 1000 以外なら設定してください

## ComfyUI の更新

イメージ内に clone しているため、更新はイメージの再ビルドで行います。

```sh
docker compose build
docker compose up -d
```

`COMFYUI_VERSION=master` の場合、`Dockerfile` が clone の直前に GitHub API で
最新リビジョンを取得しており、上流が進んだときだけ clone 以降のレイヤが
やり直しになります。更新がなければ全レイヤがキャッシュヒットして数秒で終わります。

`docker compose up` や `down` → `up` ではビルドが走らないため、意図せず
バージョンが上がることはありません。更新したいときだけ `build` を実行してください。

なお ComfyUI-Manager の UI から ComfyUI 本体を更新することもできますが、書き込み先が
コンテナの書き込み層のため `docker compose down` で巻き戻ります。本体の更新は
`docker compose build` に一本化するのが確実です。

## カスタムノードの追加

`data/custom_nodes/` に clone します。追加の Python 依存がある場合はコンテナ内でインストールし、再起動します。

```sh
git clone <repo> data/custom_nodes/<name>
docker compose exec comfyui pip install --user -r custom_nodes/<name>/requirements.txt
docker compose restart comfyui
```

コンテナは非 root で動くため `--user` を付けます（インストール先の `~/.local` は `comfy-home` ボリュームに永続化されます）。依存を確実に残したい場合は `Dockerfile` に書き足して再ビルドしてください。

## ComfyUI-Manager

ComfyUI 本体に組み込まれた `--enable-manager` を有効にしてあり、起動時から使えます。
本体が `manager_requirements.txt` で対応バージョンをピン留めしているため、
`docker compose build` で ComfyUI を更新すると Manager も対応版に追従します。

Manager がインストールしたカスタムノードは `data/custom_nodes/` に、
その Python 依存は `~/.local`（`comfy-home` ボリューム）に入るため、
どちらもコンテナを作り直しても残ります。

初回起動時に `data/user/__manager/config.ini` を以下の内容で生成します。

```ini
[default]
use_uv = False
network_mode = personal_cloud
```

`use_uv = False` は、コンテナが非 root で動く都合上、Manager 既定の `uv` が
`/opt/conda` の site-packages に書き込めず依存の導入に失敗するためです。
`pip` は `--user` へ自動的にフォールバックするので、こちらを使わせています。

`network_mode = personal_cloud` は、カスタムノードの導入が Manager の
security policy で拒否されるのを避けるためです。Manager は listen アドレスが
loopback かどうかでローカル利用を判定しますが、コンテナは外から繋ぐため
`--listen 0.0.0.0` が必須で、この判定に入れません。既定の `network_mode = public`
のままだとノードの導入が一律で失敗します（UI 上は分かりにくく、
`data/user/comfyui_8188.log` に `security_level must be ...` のエラーが出ます）。

代わりに公開範囲は Docker 側で絞っており、`COMFYUI_BIND` の既定値
`127.0.0.1` によりホスト自身からしか繋がりません。LAN に公開する場合は
「そのネットワークから誰でもカスタムノードを入れられる」状態になる点に
注意してください。

Manager の起動に失敗すると ComfyUI ごと立ち上がらなくなります
（`--enable-manager` の処理は ComfyUI 側で例外を捕捉していないため）。
その場合は `.env` の `COMFYUI_ENABLE_MANAGER=0` で切り離して起動できます。

## Danbooru Tag Composer

Danbooru タグをツリーとして編集し、組み上がった文字列だけを CLIP Text Encode に
渡すためのカスタムノードです。`custom_nodes/danbooru_tag_composer/` にあり、
`docker compose up` でそのまま読み込まれます。

カンマ区切りの長い一行を直接いじる代わりに、

- タグを**グループにまとめ**、グループごと一括で出し入れする（グループは入れ子にできる）
- **適用エリア**と**非適用エリア**を分け、非適用エリアに置いたタグは出力しない
- タグに**日本語の対訳**を表示する
- タグごとに**重み** `(tag:1.3)` を付ける

という操作ができます。位置と所属の変更はすべてドラッグ＆ドロップで、文字入力が要るのは
タグの検索と、対訳・グループ名の変更だけです。

### 使い方

1. ノード検索で「Danbooru Tag Composer」を追加し、`prompt` 出力を
   CLIP Text Encode の `text` 入力へ繋ぎます。
2. ノードの「タグを編集」ボタン、またはサイドバーの 🏷 アイコンから
   **Tag Composer** タブを開きます。編集対象はキャンバスで選択中のノードです。
3. 検索欄にタグを入れると候補が出ます（英語のタグ名でも「ロングヘア」「ろんぐへあ」の
   ような日本語でも引けます）。候補をエリアへドラッグするか、クリックで適用エリアの
   末尾に追加します。
4. 行をドラッグして並べ替え・グループへの出し入れ・適用／非適用の移動を行います。
   グループ行の**真ん中**に落とすとそのグループの中へ、**上下の端**に落とすと
   そのグループの前後に入ります。
5. 行の ⋯ メニューから、**重み `(tag:1.3)` の付け外し**・グループでくるむ・複製・削除・
   プリセット保存ができます。重みの付いたタグは行の右端に `×1.3` と出ます。

編集 UI をノードの中ではなくサイドバーに置いているのは、キャンバスのズーム／パンと
HTML5 のドラッグ＆ドロップが競合してドロップ位置がずれるためです。ノード本体には
サマリとプレビューだけを出しており、Nodes 2.0（Vue 描画）でも従来のキャンバス描画でも
同じように動きます。

### 保存される場所

タグツリーはノードの `tags` ウィジェットに JSON として入るため、**ワークフローと一緒に
保存・復元**されます。API 形式で実行しても同じ文字列が出ます。

ユーザーが手で直した対訳と、名前を付けて保存したグループ（プリセット）は
ComfyUI の userdata に入ります。

- `data/user/default/danbooru-tag-composer/overrides.json`
- `data/user/default/danbooru-tag-composer/presets.json`

タグ数が数百を超えるとワークフロー JSON もそれなりの大きさになり、生成した PNG の
メタデータにも載ります。常用する塊はプリセットに逃がすと軽くなります。

### 対訳辞書

`custom_nodes/danbooru_tag_composer/data/glossary.json.gz` に、Danbooru のタグ
32,259 件と日本語訳が入っています（**92% に対訳あり**）。リポジトリに含めてあるので
そのまま使えます。更新は再生成します（標準ライブラリのみ）。

```sh
python3 scripts/build_tag_glossary.py
```

出どころは 2 つです。

- [newtextdoc1111/danbooru-tag-csv](https://huggingface.co/datasets/newtextdoc1111/danbooru-tag-csv)（MIT）
  — タグ本体と、Danbooru Wiki の `other_names`
- [boorutan/booru-japanese-tag](https://github.com/boorutan/booru-japanese-tag)（MIT）
  — 日本語専用の対訳辞書（手作業 400 件ほど＋機械翻訳 10 万件）

#### 日本語を選び出す規則

`other_names` は「その物の別名」であって訳語ではなく、**日本語・簡体字・繁体字・
韓国語・ローマ字が混在**しています。素直に拾うと中国語が表に出るので、次の順で選びます。

1. **かなを含む候補**を最優先。かなは日本語である証拠で、かつ実際に日本語話者が
   呼んでいる名前になる（`looking_at_viewer` → カメラ目線）
2. ハングルだけ・ローマ字だけの候補は捨てる
3. 漢字のみの候補は、**簡体字を Shift_JIS へのエンコード可否で弾く**
4. 残った漢字候補は「**日本語で実際に使われる漢字の割合**」で順位を付ける。
   `崩坏` は 坏 が日本語で使われないので 0.5、`崩壊` は 1.0 なので後者を選ぶ。
   Shift_JIS の判定だけでは 坏 のような「簡体字だが稀な日本語漢字でもある」字を
   取りこぼすため、この段が要る
5. それでも無ければ日本語専用辞書で埋める

カテゴリによって順番を変えています。キャラ名・作品名は Wiki の表記が正しく、
機械翻訳は名前を壊すので後回しにします（`kamisato_ayaka` → 神里綾華）。
逆に一般タグは、機械翻訳のほうが「漢字だけで中国語かもしれない候補」より確実です。

この規則で、表示される対訳に残る簡体字は **335 件から 1 件**になりました。

#### 機械翻訳の印

対訳の 4 割（11,800 件）は機械翻訳由来で、**直訳の誤りが混ざります**
（`border` → 国境。正しくは「枠・縁」）。これらはサイドバーで*斜体・薄字・末尾に ※*
を付けて表示し、鵜呑みにしないで済むようにしてあります。クリックすれば直せて、
直した対訳は `overrides.json` に残り以降ずっと使われます。

辞書は 3 万件あるのでブラウザには送らず、検索と引き当てはサーバー側で行っています。
辞書ファイルを消しても、対訳が出なくなるだけでタグの編集自体は動きます。

### テスト

```sh
python3 -m unittest discover -s tests -v
```

プレビューの応答性のために、プロンプト文字列を組み立てる規則は Python
（`tagtree.py`、こちらが出力の正）と JavaScript（`web/js/render.js`、プレビュー用）に
二重に実装されています。両者は `tests/fixtures/render_cases.json` という同じ
期待値表でテストされるので、食い違うとテストが落ちます。JavaScript 側のテストは
`node` が入っているときだけ走ります。

## PNG のプロンプトを引き継いでアップスケールする

ComfyUI が生成した PNG を指定し、画像内のメタデータからポジティブ・
ネガティブプロンプトを取り出して `upscaling` ワークフローをキューへ投入できます。

```sh
python3 scripts/upscale.py data/output/ComfyUI_00070_.png
```

スクリプトは PNG の `prompt` メタデータを優先して解析し、ない場合は `workflow`
メタデータを解析します。画像を ComfyUI の `input/local-comfy-ui-upscale/` に
アップロードして `/prompt` へ投入した後、処理完了を待たずに `prompt_id` と
予定保存先を表示します。結果は ComfyUI のキュー画面または
`data/output/upscaling/` で確認してください。

接続先はコマンドライン、環境変数、既定値の順に選ばれます。

```sh
# コマンドラインで指定
python3 scripts/upscale.py --server http://192.168.1.10:8188 image.png

# 環境変数で指定
COMFYUI_URL=http://192.168.1.10:8188 python3 scripts/upscale.py image.png
```

`--server` と `COMFYUI_URL` がなければ、`COMFYUI_PORT`（既定 `8188`）を使った
`http://127.0.0.1:<port>` に接続します。Python の追加パッケージは不要です。

API 用ワークフローは `workflows/upscaling-api.json` にあります。UI 側の
`data/user/default/workflows/upscaling.json` で倍率、denoise、モデルなどを変更した
場合は、ComfyUI から API 形式で再エクスポートし、このファイルも更新してください。
API テンプレートには `UltimateSDUpscale`、`LoadImage`、`SaveImage` が必要で、
`UltimateSDUpscale` の positive / negative はそれぞれテキストエンコーダーへ
直接接続されている必要があります。

テストは標準の `unittest` で実行できます。

```sh
python3 -m unittest discover -s tests -v
```
