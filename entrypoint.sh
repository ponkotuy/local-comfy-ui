#!/bin/bash
set -euo pipefail

# ホストの data/models をマウントすると中身が空になるため、
# ComfyUI 標準のサブディレクトリ (checkpoints, loras, vae ...) を作り直す
if [[ -f /opt/comfyui-model-dirs.txt ]]; then
    while IFS= read -r dir; do
        [[ -n "${dir}" ]] && mkdir -p "/opt/comfyui/models/${dir}"
    done < /opt/comfyui-model-dirs.txt
fi

if [[ "${COMFYUI_ENABLE_MANAGER:-1}" == "1" ]]; then
    # ComfyUI-Manager の設定を初回だけ用意する (既存ファイルには触らない)。
    # コンテナは非 root で動くため、Manager 既定の uv は /opt/conda の
    # site-packages に書き込めずカスタムノードの依存導入に失敗する。
    # pip なら --user へ自動フォールバックし、~/.local すなわち名前付き
    # ボリューム comfy-home に入るので、こちらを使わせる
    manager_config=/opt/comfyui/user/__manager/config.ini
    if [[ ! -f "${manager_config}" ]]; then
        mkdir -p "$(dirname "${manager_config}")"
        printf '[default]\nuse_uv = False\n' > "${manager_config}"
    fi

    set -- "$@" --enable-manager
fi

exec "$@"
