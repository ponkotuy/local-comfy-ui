"""Danbooru Tag Composer — タグのツリー編集 UI を持つプロンプト組み立てノード。

NODE_CLASS_MAPPINGS は "定義しない"。本体 nodes.py の load_custom_node() は
NODE_CLASS_MAPPINGS があればそちらを優先し comfy_entrypoint を呼ばないため、
両方を書くと V3 のノードが登録されなくなる。

WEB_DIRECTORY の処理は同関数内で V1/V3 の分岐より前にあるので、V3 だけの
パッケージでもフロントエンド拡張はそのまま配信される。
"""

from .nodes import DanbooruTagComposerExtension
from . import api  # noqa: F401  # import した時点で HTTP ルートが登録される

WEB_DIRECTORY = "./web"


async def comfy_entrypoint() -> DanbooruTagComposerExtension:
    return DanbooruTagComposerExtension()


__all__ = ["WEB_DIRECTORY", "comfy_entrypoint"]
