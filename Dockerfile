FROM pytorch/pytorch:2.9.1-cuda12.8-cudnn9-runtime

# ComfyUI の取得先リビジョン (タグ or ブランチ)
ARG COMFYUI_VERSION=master

# GIT_CONFIG_* は safe.directory の設定。/opt/comfyui は root 所有だが実行は
# 非 root のため、そのままだと git が "dubious ownership" で操作を拒否する。
# ComfyUI-Manager は GitPython でリポジトリを読むのでこれを許可しておく
ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/home/comfyui \
    GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=safe.directory \
    GIT_CONFIG_VALUE_0=*

RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        ca-certificates \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt
# 取得先リビジョンが進んだときだけ、以降のレイヤのキャッシュを落とすための
# ダミー取得。これがないと COMFYUI_VERSION=master でも git clone の
# レイヤが再利用され続け、docker compose build しても更新されない
ADD https://api.github.com/repos/comfyanonymous/ComfyUI/commits/${COMFYUI_VERSION} /opt/comfyui-rev.json
RUN git clone --depth 1 --branch "${COMFYUI_VERSION}" \
        https://github.com/comfyanonymous/ComfyUI.git comfyui

WORKDIR /opt/comfyui
# ベースイメージの torch/torchvision/torchaudio はそのまま流用される
RUN pip install --no-cache-dir -r requirements.txt

# ComfyUI-Manager。ComfyUI 本体に組み込まれた --enable-manager で有効化する。
# 対応バージョンは本体が manager_requirements.txt にピン留めしているため、
# ここではバージョンを指定しない (本体の更新に追従させる)
RUN pip install --no-cache-dir -r manager_requirements.txt

# models/ はホストのボリュームで上書きされるため、標準サブディレクトリの一覧を
# 退避しておき、起動時に entrypoint で作り直す
RUN find models -mindepth 1 -maxdepth 1 -type d -printf '%f\n' > /opt/comfyui-model-dirs.txt

# compose の user: でホストの uid/gid を指定して動かせるようにする
RUN mkdir -p "${HOME}/.cache" "${HOME}/.local" \
    && chmod -R a+rwX "${HOME}" /opt/comfyui

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 8188

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["python", "main.py", "--listen", "0.0.0.0", "--port", "8188"]
