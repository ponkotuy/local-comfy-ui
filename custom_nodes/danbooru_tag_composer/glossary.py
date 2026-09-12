"""Danbooru タグ辞書の読み込みと検索。

scripts/build_tag_glossary.py が作る data/glossary.json.gz を読む。中身は

    {"version": 2, "generated": "...",
     "tags": {"1girl": [0, 4974288, 0, ["女の子", "おんなのこ", ...]], ...}}

で、値は [カテゴリ, 投稿数, 対訳の出どころ, 読み] の並び。読みの先頭が表示用で、
残りは検索用。出どころは MACHINE (機械翻訳) のとき誤訳がありうるため、
フロントエンドはそれを暫定扱いで表示する。

3 万件あるので、これを丸ごとブラウザへ送ることはしない (それをやっている既存の
補完拡張はタグが増えるたびに重くなる)。検索はここで済ませ、候補だけを返す。
"""

from __future__ import annotations

import gzip
import json
from pathlib import Path
import re
from typing import Any, Iterable

DATA_PATH = Path(__file__).resolve().parent / "data" / "glossary.json.gz"

# Danbooru のタグカテゴリ。2 は欠番
CATEGORY_NAMES = {0: "general", 1: "artist", 3: "copyright", 4: "character", 5: "meta"}

# 対訳の出どころ。build_tag_glossary.py と対応している
SOURCE_WIKI_KANA = 0
SOURCE_WIKI_KANJI = 1
SOURCE_MANUAL = 2
SOURCE_MACHINE = 3
SOURCE_NONE = -1

# 片仮名を平仮名に寄せるための差分。"ロングヘア" と "ろんぐへあ" を同じものとして
# 検索できるようにする
_KATAKANA_TO_HIRAGANA = {c: c - 0x60 for c in range(0x30A1, 0x30F7)}

_JAPANESE_RE = re.compile(r"[ぁ-ゟ゠-ヿ一-鿿]")


def fold(text: str) -> str:
    """検索用に表記ゆれを潰す。小文字化・アンダースコアと空白の同一視・片仮名の平仮名化。"""
    return text.lower().replace("_", " ").translate(_KATAKANA_TO_HIRAGANA)


class Glossary:
    """タグ名と日本語の読みの両方から引ける辞書。"""

    def __init__(self, tags: dict[str, list[Any]] | None = None, generated: str = ""):
        self.generated = generated
        self._entries: dict[str, list[Any]] = tags or {}
        # 検索対象をタグごとに 1 本の文字列へ畳んでおく。エントリ数が 3 万程度なので
        # 索引を作り込むより素直に走査したほうが速いし壊れにくい
        self._haystack: list[tuple[str, str, str, int]] = []
        for tag, (_category, count, _source, readings) in self._entries.items():
            self._haystack.append(
                (tag, fold(tag), " ".join(fold(r) for r in readings), count)
            )
        self._haystack.sort(key=lambda row: -row[3])

    def __len__(self) -> int:
        return len(self._entries)

    def lookup(self, tag: str) -> dict[str, Any] | None:
        entry = self._entries.get(tag)
        if entry is None:
            return None
        category, count, source, readings = entry
        return {
            "tag": tag,
            "category": category,
            "categoryName": CATEGORY_NAMES.get(category, "general"),
            "count": count,
            "ja": readings[0] if readings else None,
            # 機械翻訳は誤訳がありうるので、UI 側で暫定と分かるようにする
            "source": source,
            "readings": readings,
        }

    def translate(self, tags: Iterable[str]) -> dict[str, list[Any]]:
        """タグ -> [対訳, 出どころ]。対訳が無いタグはキーごと省く。"""
        out: dict[str, list[Any]] = {}
        for tag in tags:
            entry = self._entries.get(tag)
            if entry and entry[3]:
                out[tag] = [entry[3][0], entry[2]]
        return out

    def suggest(self, query: str, limit: int = 30) -> list[dict[str, Any]]:
        """前方一致を先に、部分一致をその後に、それぞれ投稿数の多い順で返す。

        日本語で引かれたときはタグ名を見ても当たらないので読みだけを探す。
        逆に英字で引かれたときも読みを見る必要はない。
        """
        needle = fold(query.strip())
        if not needle:
            return []

        search_readings = bool(_JAPANESE_RE.search(query))

        prefix: list[str] = []
        partial: list[str] = []
        for tag, folded_tag, folded_readings, _count in self._haystack:
            hay = folded_readings if search_readings else folded_tag
            if not hay:
                continue
            if hay.startswith(needle):
                prefix.append(tag)
            elif needle in hay:
                partial.append(tag)
            # 前方一致だけで足りている場合でも部分一致を探し続ける必要はない
            if len(prefix) >= limit:
                break

        results = (prefix + partial)[:limit]
        return [entry for entry in (self.lookup(tag) for tag in results) if entry]


_cache: Glossary | None = None


def get() -> Glossary:
    """辞書のシングルトン。

    辞書ファイルが無い環境でも拡張は動く必要があるので、読めなければ空の辞書を返す
    (対訳が出ないだけで、タグの編集そのものは辞書に依存しない)。
    """
    global _cache
    if _cache is None:
        _cache = _load(DATA_PATH)
    return _cache


def _load(path: Path) -> Glossary:
    try:
        with gzip.open(path, "rb") as handle:
            data = json.loads(handle.read().decode("utf-8"))
    except (OSError, ValueError):
        return Glossary()

    tags = data.get("tags")
    if not isinstance(tags, dict):
        return Glossary()
    return Glossary(tags, generated=str(data.get("generated") or ""))
