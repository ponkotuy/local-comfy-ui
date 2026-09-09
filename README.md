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

モデルは `data/models/checkpoints/` などに配置してください。`checkpoints` / `loras` / `vae` といった標準サブディレクトリは、コンテナ起動時に `entrypoint.sh` が作成します。

コンテナはホストと同じ uid/gid で動くため、生成された画像やワークフローはホスト側で自分の所有になります。

Hugging Face のキャッシュ (`~/.cache`) と追加インストールした Python パッケージ (`~/.local`) は名前付きボリューム `comfy-home` に保存され、コンテナを作り直しても残ります。

## 設定

`.env.example` を `.env` にコピーして編集します。

- `COMFYUI_PORT` — ホスト側の公開ポート（既定 `8188`）
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

初回起動時に `data/user/__manager/config.ini` を `use_uv = False` で生成します。
コンテナが非 root で動く都合上、Manager 既定の `uv` は `/opt/conda` の
site-packages に書き込めず依存の導入に失敗するためです。`pip` は `--user` へ
自動的にフォールバックするので、こちらを使わせています。

Manager の起動に失敗すると ComfyUI ごと立ち上がらなくなります
（`--enable-manager` の処理は ComfyUI 側で例外を捕捉していないため）。
その場合は `.env` の `COMFYUI_ENABLE_MANAGER=0` で切り離して起動できます。

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
