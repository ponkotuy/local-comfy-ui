"""タグツリーからプロンプト文字列を組み立てる。

このモジュールが出力文字列の唯一の正。フロントエンドにも同じ規則のプレビュー
実装 (web/js/render.js) があるが、ワークフロー実行時に CLIP Text Encode へ渡るのは
常にこちらの結果なので、規則を変えるときは必ず両方を直し
tests/fixtures/render_cases.json を更新すること。

ツリーの形:

    {"version": 1,
     "active":   [node, ...],    # ここにあるタグだけが出力される
     "inactive": [node, ...]}    # 手元に取っておくだけのタグ

node は 2 種類:

    {"id": "...", "kind": "tag",   "tag": "1girl", "on": true, "w": 1.0, "ja": null}
    {"id": "...", "kind": "group", "name": "キャラ", "on": true, "open": true,
     "children": [node, ...]}

グループは入れ子にできる。"on": false のノードは出力されず、グループなら配下ごと
まるごと落ちる。"ja" はユーザーが明示的に上書きした対訳だけを入れる (通常は null で、
表示時に辞書から引く)。ワークフロー JSON に載るデータなのでキー名は短くしてある。
"""

from __future__ import annotations

import json
from typing import Any, Iterator

SCHEMA_VERSION = 1

# 適用エリアと非適用エリア。並び順がそのまま UI の並び順
AREAS = ("active", "inactive")

# グループの入れ子の上限。壊れたデータで再帰が止まらなくなるのを防ぐだけの値で、
# 実用上ここに当たることはない
MAX_DEPTH = 32

# 重みの範囲。ComfyUI 側に制限はないが、事故を防ぐために丸めておく
MIN_WEIGHT = 0.0
MAX_WEIGHT = 10.0

DEFAULT_SEPARATOR = ", "

EMPTY_TREE: dict[str, Any] = {"version": SCHEMA_VERSION, "active": [], "inactive": []}
EMPTY_JSON = json.dumps(EMPTY_TREE, separators=(",", ":"))


def loads(data: Any) -> dict[str, Any]:
    """JSON 文字列・dict のどちらを渡しても正規化済みのツリーを返す。

    壊れた入力は例外にせず空のツリーとして扱う。ワークフローの実行を
    JSON のパースエラーで止めないため。
    """
    if isinstance(data, (bytes, bytearray)):
        data = data.decode("utf-8", "replace")
    if isinstance(data, str):
        text = data.strip()
        if not text:
            return normalize(None)
        try:
            data = json.loads(text)
        except ValueError:
            return normalize(None)
    return normalize(data)


def dumps(tree: dict[str, Any]) -> str:
    """ワークフローに載せる形の JSON 文字列にする。"""
    return json.dumps(tree, ensure_ascii=False, separators=(",", ":"))


def normalize(data: Any) -> dict[str, Any]:
    """未知のキーを落とし、欠けた値を既定値で埋めた正規形を返す。"""
    if not isinstance(data, dict):
        return {"version": SCHEMA_VERSION, "active": [], "inactive": []}

    tree: dict[str, Any] = {"version": SCHEMA_VERSION}
    for area in AREAS:
        tree[area] = _normalize_nodes(data.get(area), depth=0)
    return tree


def _normalize_nodes(nodes: Any, *, depth: int) -> list[dict[str, Any]]:
    if not isinstance(nodes, list) or depth > MAX_DEPTH:
        return []
    return [n for n in (_normalize_node(n, depth=depth) for n in nodes) if n is not None]


def _normalize_node(node: Any, *, depth: int) -> dict[str, Any] | None:
    if not isinstance(node, dict):
        return None

    if node.get("kind") == "group":
        return {
            "id": _clean_id(node.get("id")),
            "kind": "group",
            "name": _clean_text(node.get("name")),
            "on": node.get("on", True) is not False,
            "open": node.get("open", True) is not False,
            "children": _normalize_nodes(node.get("children"), depth=depth + 1),
        }

    # kind が無い / 壊れている場合もタグとして扱う。タグ名が空なら捨てる
    tag = _clean_text(node.get("tag"))
    if not tag:
        return None
    ja = _clean_text(node.get("ja"))
    return {
        "id": _clean_id(node.get("id")),
        "kind": "tag",
        "tag": tag,
        "on": node.get("on", True) is not False,
        "w": _clean_weight(node.get("w")),
        "ja": ja or None,
    }


def _clean_text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _clean_id(value: Any) -> str:
    # id はフロントエンドが振る。無ければ空のままにしておき、UI 側で補完させる
    return value if isinstance(value, str) and value else ""


def _clean_weight(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 1.0
    weight = float(value)
    if weight != weight:  # NaN
        return 1.0
    return max(MIN_WEIGHT, min(MAX_WEIGHT, weight))


def iter_tags(
    tree: dict[str, Any], area: str = "active", *, only_enabled: bool = True
) -> Iterator[dict[str, Any]]:
    """エリア配下のタグノードを表示順に返す。

    only_enabled=True のとき "on": false のノードは飛ばし、グループなら
    その部分木ごと辿らない。
    """
    yield from _iter_tags(tree.get(area) or [], only_enabled=only_enabled)


def _iter_tags(nodes: list[dict[str, Any]], *, only_enabled: bool) -> Iterator[dict[str, Any]]:
    for node in nodes:
        if only_enabled and not node.get("on", True):
            continue
        if node.get("kind") == "group":
            yield from _iter_tags(node.get("children") or [], only_enabled=only_enabled)
        else:
            yield node


def format_weight(weight: float) -> str:
    """(tag:1.2) の 1.2 の部分。小数第 2 位まで、末尾の 0 は落とす。"""
    text = f"{weight:.2f}".rstrip("0")
    return text + "0" if text.endswith(".") else text


def escape_tag(tag: str) -> str:
    r"""タグ名に含まれる括弧を潰す。

    Danbooru のタグには saber_(fate) のように括弧を含むものがあり、そのまま出すと
    ComfyUI の重み記法として解釈されてしまう。本体 comfy/sd1_clip.py の
    escape_important() が見るのは \( と \) だけなので、この 2 つだけを escape する
    (バックスラッシュ自体に escape の仕組みは無い)。
    """
    return tag.replace("(", r"\(").replace(")", r"\)")


def render(
    data: Any,
    *,
    separator: str = DEFAULT_SEPARATOR,
    underscore_to_space: bool = False,
) -> str:
    """適用エリアの有効なタグだけをつないだプロンプト文字列を返す。

    同じタグが複数回現れた場合は最初のものだけを残す。重複は重みが二重に
    かかるだけで得がなく、グループを組み合わせていると簡単に起きるため。
    """
    tree = loads(data)

    parts: list[str] = []
    seen: set[str] = set()
    for node in iter_tags(tree, "active"):
        tag = node["tag"]
        if underscore_to_space:
            tag = tag.replace("_", " ")
        if tag in seen:
            continue
        seen.add(tag)

        tag = escape_tag(tag)
        weight = node["w"]
        parts.append(tag if weight == 1.0 else f"({tag}:{format_weight(weight)})")

    return separator.join(parts)


def count_tags(data: Any) -> dict[str, int]:
    """ノード上のサマリ表示に使う件数。"""
    tree = loads(data)
    return {
        "active": sum(1 for _ in iter_tags(tree, "active")),
        "active_total": sum(1 for _ in iter_tags(tree, "active", only_enabled=False)),
        "inactive": sum(1 for _ in iter_tags(tree, "inactive", only_enabled=False)),
    }
