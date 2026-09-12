#!/usr/bin/env python3
"""Build the Danbooru Tag Composer glossary.

Two upstreams are merged:

* The Danbooru tag CSV, whose ``alias`` column is a copy of the Danbooru wiki's
  ``other_names``. Those are the names people actually use, but they mix
  Japanese, simplified and traditional Chinese, Korean and romaji, so the
  Japanese ones have to be picked out (see ``pick_reading``).
* boorutan/booru-japanese-tag, a Japanese-only dictionary. Its small hand-made
  file is trustworthy; its large one is machine translated and does contain
  literal mistranslations (border -> 国境), so entries taken from it are marked
  and the UI shows them as provisional.

Run it only when the glossary needs refreshing; the generated file is committed.
"""

from __future__ import annotations

import argparse
import collections
import csv
import datetime
import gzip
import io
import json
from pathlib import Path
import re
import sys
from typing import Any, Iterable
import urllib.error
import urllib.request

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = PROJECT_ROOT / "custom_nodes" / "danbooru_tag_composer" / "data" / "glossary.json.gz"

# https://huggingface.co/datasets/newtextdoc1111/danbooru-tag-csv (MIT)
TAGS_URL = (
    "https://huggingface.co/datasets/newtextdoc1111/danbooru-tag-csv"
    "/resolve/main/danbooru_tags.csv"
)
# https://github.com/boorutan/booru-japanese-tag (MIT)
JP_BASE = "https://raw.githubusercontent.com/boorutan/booru-japanese-tag/master"
MANUAL_URL = f"{JP_BASE}/danbooru-jp.csv"
MACHINE_URL = f"{JP_BASE}/danbooru-machine-jp.csv"

GLOSSARY_VERSION = 2

# 対訳の出どころ。フロントエンドは MACHINE を「暫定」として薄く見せる
SOURCE_WIKI_KANA = 0
SOURCE_WIKI_KANJI = 1
SOURCE_MANUAL = 2
SOURCE_MACHINE = 3

# 1 タグあたりに残す読みの数。先頭が表示用で、残りは検索用
MAX_READINGS = 6

MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024

# ゼロ幅スペースなどの不可視文字。上流の機械翻訳側に紛れており、放っておくと
# 目に見えない差で検索が外れる (コー<ZWSP><ZWSP>ヒーテーブル が実在する)
INVISIBLE_RE = re.compile(r"[\u200b-\u200f\u202a-\u202e\u2060\ufeff]")

KANA_RE = re.compile(r"[ぁ-ゟ゠-ヿ]")
HANGUL_RE = re.compile(r"[가-힣ᄀ-ᇿ]")
CJK_RE = re.compile(r"[一-鿿]")

# 漢字だけの候補を採るとき、この割合以上が日本語で使われる字であることを求める
MIN_JAPANESE_RATIO = 0.5
# 日本語の字と見なすのに必要な、標本中での出現回数
MIN_KANJI_OCCURRENCES = 2


class BuildError(Exception):
    """An expected error that should be shown without a traceback."""


def read_source(source: str) -> str:
    """Return the text of a URL or a local path."""
    if "://" not in source:
        path = Path(source)
        if not path.is_file():
            raise BuildError(f"No such file: {source}")
        return path.read_text(encoding="utf-8")

    request = urllib.request.Request(source, headers={"User-Agent": "local-comfy-ui"})
    try:
        with urllib.request.urlopen(request) as response:
            raw = response.read(MAX_DOWNLOAD_BYTES + 1)
    except urllib.error.URLError as exc:
        raise BuildError(f"Failed to download {source}: {exc}") from exc
    if len(raw) > MAX_DOWNLOAD_BYTES:
        raise BuildError(f"Download exceeded {MAX_DOWNLOAD_BYTES} bytes: {source}")
    return raw.decode("utf-8")


def read_pairs(source: str) -> dict[str, str]:
    """Read a two-column ``tag,japanese`` CSV. The first entry for a tag wins."""
    out: dict[str, str] = {}
    for row in csv.reader(io.StringIO(read_source(source))):
        if len(row) >= 2 and row[0] and clean(row[1]):
            out.setdefault(row[0], clean(row[1]))
    return out


def clean(text: str) -> str:
    return INVISIBLE_RE.sub("", text).strip()


def is_japanese_writable(text: str) -> bool:
    """Whether every ideograph in the text is one Japanese can write.

    Simplified Chinese characters are absent from JIS X 0208, so failing to
    encode is a cheap and reliable way to spot them. Only ideographs are
    checked: Japanese titles are full of symbols outside JIS (デリシャスパーティ♡
    プリキュア, らんま1⁄2) and testing those would throw them away.

    It is not a complete test either: a few simplified forms (坏 in 崩坏) double
    as rare Japanese kanji and pass here, which is what ``japanese_ratio`` is for.
    """
    for char in text:
        if not CJK_RE.match(char):
            continue
        try:
            char.encode("shift_jis")
        except UnicodeEncodeError:
            return False
    return True


def common_kanji(japanese_texts: Iterable[str]) -> set[str]:
    """The kanji that actually turn up in a large sample of Japanese text.

    Used to tell 崩壊 from 崩坏 and 戦艦少女 from 戰艦少女, which the JIS test
    alone cannot do. Deriving the set from the Japanese dictionary we already
    download keeps the script free of a bundled character list.
    """
    counts = collections.Counter(
        char for text in japanese_texts for char in text if CJK_RE.match(char)
    )
    return {char for char, n in counts.items() if n >= MIN_KANJI_OCCURRENCES}


def japanese_ratio(text: str, kanji: set[str]) -> float:
    """How much of the text is written with kanji used in Japanese."""
    chars = [c for c in text if CJK_RE.match(c)]
    if not chars:
        return 1.0
    return sum(c in kanji for c in chars) / len(chars)


def split_readings(aliases: str, kanji: set[str]) -> tuple[list[str], list[str]]:
    """Split the wiki's other_names into Japanese readings, dropping the rest.

    Returns (kana-bearing, kanji-only). Korean and plain romaji are discarded,
    as is anything that fails the checks above. The kanji-only list is ordered
    most-Japanese first so 崩壊 beats 崩坏.
    """
    kana: list[str] = []
    kanji_only: list[str] = []
    for alias in aliases.split(","):
        alias = clean(alias)
        if not alias or HANGUL_RE.search(alias):
            continue
        if KANA_RE.search(alias):
            kana.append(alias)
        elif CJK_RE.search(alias) and is_japanese_writable(alias):
            kanji_only.append(alias)

    kanji_only.sort(key=lambda a: -japanese_ratio(a, kanji))
    kanji_only = [a for a in kanji_only if japanese_ratio(a, kanji) >= MIN_JAPANESE_RATIO]
    return dedupe(kana), dedupe(kanji_only)


def dedupe(items: list[str]) -> list[str]:
    seen: list[str] = []
    for item in items:
        if item not in seen:
            seen.append(item)
    return seen


def pick_reading(
    tag: str,
    category: int,
    kana: list[str],
    kanji_only: list[str],
    manual: dict[str, str],
    machine: dict[str, str],
) -> tuple[str, int] | None:
    """Choose what to display for a tag, and say where it came from.

    Kana always wins: it is unambiguously Japanese and it is what people
    actually call the thing (looking_at_viewer -> カメラ目線 beats the hand-made
    dictionary's 主観視点, which means POV).

    After that the order depends on the category. For characters and copyrights
    the wiki spelling is the right answer and a machine translation would mangle
    the name, so kanji comes next. For everything else a machine translation is
    at least certainly Japanese, so it goes ahead of a kanji-only candidate that
    might still be Chinese.
    """
    is_name = category in (3, 4)
    order = ("kana", "kanji", "manual", "machine") if is_name else (
        "kana", "manual", "machine", "kanji"
    )
    for step in order:
        if step == "kana" and kana:
            return kana[0], SOURCE_WIKI_KANA
        if step == "kanji" and kanji_only:
            return kanji_only[0], SOURCE_WIKI_KANJI
        if step == "manual" and tag in manual:
            return manual[tag], SOURCE_MANUAL
        if step == "machine" and tag in machine:
            return machine[tag], SOURCE_MACHINE
    return None


def build(tags_csv: str, manual: dict[str, str], machine: dict[str, str]) -> dict[str, Any]:
    reader = csv.DictReader(io.StringIO(tags_csv))
    missing = {"tag", "category", "count", "alias"} - set(reader.fieldnames or [])
    if missing:
        raise BuildError(f"CSV is missing column(s): {', '.join(sorted(missing))}")

    kanji = common_kanji(machine.values())
    tags: dict[str, list[Any]] = {}
    for row in reader:
        tag = (row.get("tag") or "").strip()
        if not tag:
            continue
        try:
            category = int(row.get("category") or 0)
            count = int(float(row.get("count") or 0))
        except ValueError:
            continue

        kana_readings, kanji_readings = split_readings(row.get("alias") or "", kanji)
        chosen = pick_reading(tag, category, kana_readings, kanji_readings, manual, machine)

        # 先頭が表示用、残りは検索用。日本語以外はここまでで落ちている
        readings = dedupe(
            ([chosen[0]] if chosen else []) + kana_readings + kanji_readings
        )[:MAX_READINGS]
        # [カテゴリ, 投稿数, 対訳の出どころ, 読み] をリストで持つ。
        # オブジェクトにするとキー名だけでファイルが 3 割増える
        tags[tag] = [category, count, chosen[1] if chosen else -1, readings]

    if not tags:
        raise BuildError("No tags parsed from the CSV")

    return {
        "version": GLOSSARY_VERSION,
        "generated": datetime.date.today().isoformat(),
        "tags": tags,
    }


def write(glossary: dict[str, Any], output: Path) -> None:
    payload = json.dumps(glossary, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    output.parent.mkdir(parents=True, exist_ok=True)
    # mtime=0 so rebuilding unchanged data produces an identical file
    with gzip.GzipFile(output, "wb", compresslevel=9, mtime=0) as handle:
        handle.write(payload)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tags", default=TAGS_URL, help="Danbooru tag CSV (URL or path)")
    parser.add_argument("--manual", default=MANUAL_URL, help="hand-made Japanese CSV")
    parser.add_argument("--machine", default=MACHINE_URL, help="machine translated Japanese CSV")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help=f"default: {DEFAULT_OUTPUT}")
    args = parser.parse_args(argv)

    try:
        glossary = build(read_source(args.tags), read_pairs(args.manual), read_pairs(args.machine))
        write(glossary, args.output)
    except BuildError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    labels = {
        SOURCE_WIKI_KANA: "wiki (kana)",
        SOURCE_WIKI_KANJI: "wiki (kanji)",
        SOURCE_MANUAL: "hand-made",
        SOURCE_MACHINE: "machine",
    }
    counts = collections.Counter(entry[2] for entry in glossary["tags"].values())
    total = len(glossary["tags"])
    translated = total - counts[-1]
    print(f"{args.output}: {total} tags, {translated} translated ({translated / total:.1%})")
    for source, label in labels.items():
        print(f"  {label:14} {counts[source]:6}")
    print(f"  {'none':14} {counts[-1]:6}")
    print(f"  file size      {args.output.stat().st_size / 1024:.0f} KiB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
