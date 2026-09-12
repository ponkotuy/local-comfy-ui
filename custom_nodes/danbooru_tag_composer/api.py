"""フロントエンドから叩く HTTP ルート。

辞書は 3 万件あるのでまとめてブラウザへ渡さず、検索と引き当てだけをここで受ける。
ユーザーが登録した対訳の上書きやプリセットは ComfyUI の /userdata に置くので
(フロントエンドの api.storeUserData がそのまま使える)、このモジュールでは扱わない。
"""

from __future__ import annotations

import json

from aiohttp import web
from server import PromptServer

from . import glossary, tagtree

PREFIX = "/danbooru-tag-composer"

# 1 リクエストで返す候補の上限。UI に出しきれない数を返しても意味がない
MAX_SUGGEST_LIMIT = 100

# 対訳の一括引き当てで受け付けるタグ数の上限
MAX_TRANSLATE_TAGS = 2000

routes = PromptServer.instance.routes


@routes.get(f"{PREFIX}/suggest")
async def suggest(request: web.Request) -> web.Response:
    """タグ名または日本語の読みから候補を返す。"""
    query = request.query.get("q", "")
    try:
        limit = int(request.query.get("limit", 30))
    except ValueError:
        limit = 30
    limit = max(1, min(MAX_SUGGEST_LIMIT, limit))

    return web.json_response({"items": glossary.get().suggest(query, limit)})


@routes.post(f"{PREFIX}/translate")
async def translate(request: web.Request) -> web.Response:
    """タグの配列を受け取り、対訳のあるものだけを {タグ: [対訳, 出どころ]} で返す。"""
    try:
        payload = await request.json()
    except (json.JSONDecodeError, ValueError):
        return web.json_response({"error": "invalid JSON body"}, status=400)

    tags = payload.get("tags") if isinstance(payload, dict) else None
    if not isinstance(tags, list):
        return web.json_response({"error": "'tags' must be a list"}, status=400)

    wanted = [tag for tag in tags[:MAX_TRANSLATE_TAGS] if isinstance(tag, str)]
    return web.json_response({"translations": glossary.get().translate(wanted)})


@routes.post(f"{PREFIX}/render")
async def render(request: web.Request) -> web.Response:
    """ツリーからプロンプト文字列を組み立てる。

    プレビューは web/js/render.js が即時に作るのでこれを待つ必要はないが、
    JS 側の実装が Python 側とずれていないかを確かめる口として置いてある
    (詳しくは tests/fixtures/render_cases.json)。
    """
    try:
        payload = await request.json()
    except (json.JSONDecodeError, ValueError):
        return web.json_response({"error": "invalid JSON body"}, status=400)
    if not isinstance(payload, dict):
        return web.json_response({"error": "body must be an object"}, status=400)

    options = payload.get("options") or {}
    if not isinstance(options, dict):
        options = {}

    return web.json_response(
        {
            "prompt": tagtree.render(
                payload.get("tree"),
                separator=str(options.get("separator", tagtree.DEFAULT_SEPARATOR)),
                underscore_to_space=bool(options.get("underscore_to_space", False)),
            )
        }
    )


@routes.get(f"{PREFIX}/status")
async def status(_request: web.Request) -> web.Response:
    """辞書が読めているか。フロントエンドが起動時に一度だけ確認する。"""
    loaded = glossary.get()
    return web.json_response({"tags": len(loaded), "generated": loaded.generated})
