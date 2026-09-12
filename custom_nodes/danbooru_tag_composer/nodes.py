"""Danbooru Tag Composer のノード定義。

ノード定義は V3 スキーマ (comfy_api.latest の io.ComfyNode / define_schema) で書いて
いる。本体の comfy_extras/ はすでに全面的にこちらへ移行済みで、新しい入力の種類は
V3 にしか追加されないため。

UI の実体は web/js 側 (サイドバーパネル) にあり、このノードが持つのは tree ウィジェット
に入った JSON だけ。バックエンドにも同じ JSON が渡るので、ブラウザを介さない API 実行
でもまったく同じ文字列が出る。
"""

from __future__ import annotations

from comfy_api.latest import ComfyExtension, io

from . import tagtree


class DanbooruTagComposer(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="DanbooruTagComposer",
            display_name="Danbooru Tag Composer",
            category="utils/text",
            search_aliases=["danbooru", "tag", "prompt", "タグ", "プロンプト"],
            # ComfyUI の作法にあわせて既定は英語にし、日本語は locales/ja/nodeDefs.json で出す
            description=(
                "Group Danbooru tags into a nested tree and output only the enabled tags "
                "in the active area. Edit the tree from the Tag Composer sidebar tab."
            ),
            inputs=[
                io.String.Input(
                    "tree",
                    display_name="tags",
                    multiline=True,
                    default=tagtree.EMPTY_JSON,
                    tooltip="Tag tree as JSON. Normally edited from the Tag Composer sidebar tab.",
                ),
                io.String.Input(
                    "separator",
                    default=tagtree.DEFAULT_SEPARATOR,
                    tooltip="Text placed between tags.",
                    advanced=True,
                ),
                io.Boolean.Input(
                    "underscore_to_space",
                    default=False,
                    tooltip="Emit long_hair as long hair.",
                    advanced=True,
                ),
            ],
            outputs=[io.String.Output(display_name="prompt")],
        )

    @classmethod
    def execute(cls, tree: str, separator: str, underscore_to_space: bool) -> io.NodeOutput:
        return io.NodeOutput(
            tagtree.render(
                tree, separator=separator, underscore_to_space=underscore_to_space
            )
        )


class DanbooruTagComposerExtension(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [DanbooruTagComposer]
