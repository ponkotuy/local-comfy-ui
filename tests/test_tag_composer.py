"""Tests for the Danbooru Tag Composer prompt renderer."""

from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import sys
import unittest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
NODE_ROOT = PROJECT_ROOT / "custom_nodes" / "danbooru_tag_composer"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "render_cases.json"

# The extension lives under custom_nodes/ so ComfyUI can load it; import it directly
# rather than installing anything.
sys.path.insert(0, str(NODE_ROOT))

import tagtree  # noqa: E402


class RenderFixtureTest(unittest.TestCase):
    """Run the shared fixture that web/js/render.js is also checked against."""

    def test_fixture_cases(self):
        cases = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]
        self.assertTrue(cases)
        for case in cases:
            with self.subTest(case["name"]):
                options = case.get("options") or {}
                self.assertEqual(
                    tagtree.render(
                        case["tree"],
                        separator=options.get("separator", tagtree.DEFAULT_SEPARATOR),
                        underscore_to_space=options.get("underscore_to_space", False),
                    ),
                    case["expected"],
                )


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class JavaScriptTest(unittest.TestCase):
    """Run the extension's JavaScript tests through the same command as the Python ones.

    web/js/render.js mirrors tagtree.py so the sidebar preview can keep up with
    dragging; both are checked against tests/fixtures/render_cases.json here so the
    two implementations cannot drift apart unnoticed. A drift would show up in normal
    use as "the preview disagrees with what was generated", which is easy to miss.
    """

    def run_js(self, script, *args):
        result = subprocess.run(
            ["node", str(NODE_ROOT / "tests" / script), *args],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_render_matches_the_python_renderer(self):
        self.run_js("render.test.mjs", str(FIXTURE))

    def test_tree_operations(self):
        self.run_js("model.test.mjs")


class RenderInputTest(unittest.TestCase):
    def test_accepts_json_string(self):
        payload = json.dumps({"active": [{"kind": "tag", "tag": "1girl"}]})
        self.assertEqual(tagtree.render(payload), "1girl")

    def test_broken_input_renders_empty(self):
        for payload in ["", "   ", "not json", "[1, 2, 3]", "null", None, 42]:
            with self.subTest(repr(payload)):
                self.assertEqual(tagtree.render(payload), "")

    def test_empty_json_constant_round_trips(self):
        self.assertEqual(tagtree.loads(tagtree.EMPTY_JSON), tagtree.EMPTY_TREE)
        self.assertEqual(tagtree.render(tagtree.EMPTY_JSON), "")


class NormalizeTest(unittest.TestCase):
    def test_drops_unknown_keys_and_fills_defaults(self):
        tree = tagtree.normalize(
            {"active": [{"kind": "tag", "tag": "1girl", "bogus": "x"}], "junk": 1}
        )
        self.assertEqual(
            tree,
            {
                "version": tagtree.SCHEMA_VERSION,
                "active": [
                    {"id": "", "kind": "tag", "tag": "1girl", "on": True, "w": 1.0, "ja": None}
                ],
                "inactive": [],
            },
        )

    def test_group_defaults(self):
        tree = tagtree.normalize({"active": [{"kind": "group"}]})
        self.assertEqual(
            tree["active"],
            [{"id": "", "kind": "group", "name": "", "on": True, "open": True, "children": []}],
        )

    def test_missing_kind_is_treated_as_tag(self):
        tree = tagtree.normalize({"active": [{"tag": "1girl"}]})
        self.assertEqual(tree["active"][0]["kind"], "tag")

    def test_non_dict_nodes_are_dropped(self):
        tree = tagtree.normalize({"active": ["x", None, 3, {"kind": "tag", "tag": "a"}]})
        self.assertEqual([n["tag"] for n in tree["active"]], ["a"])

    def test_weight_of_wrong_type_falls_back_to_one(self):
        for value in ["1.2", None, True, [1], float("nan")]:
            with self.subTest(repr(value)):
                tree = tagtree.normalize({"active": [{"kind": "tag", "tag": "a", "w": value}]})
                self.assertEqual(tree["active"][0]["w"], 1.0)

    def test_depth_limit_truncates_runaway_nesting(self):
        node: dict = {"kind": "tag", "tag": "deep"}
        for _ in range(tagtree.MAX_DEPTH + 5):
            node = {"kind": "group", "name": "g", "children": [node]}
        # Normalisation must terminate and the over-deep leaf must not be rendered.
        self.assertEqual(tagtree.render({"active": [node]}), "")

    def test_dumps_keeps_japanese_readable(self):
        tree = tagtree.normalize({"active": [{"kind": "group", "name": "キャラ", "children": []}]})
        self.assertIn("キャラ", tagtree.dumps(tree))


class IterTagsTest(unittest.TestCase):
    TREE = {
        "active": [
            {"kind": "tag", "tag": "a"},
            {"kind": "group", "name": "g", "on": False, "children": [{"kind": "tag", "tag": "b"}]},
            {"kind": "tag", "tag": "c", "on": False},
        ],
        "inactive": [{"kind": "tag", "tag": "d"}],
    }

    def test_only_enabled_by_default(self):
        tree = tagtree.loads(self.TREE)
        self.assertEqual([n["tag"] for n in tagtree.iter_tags(tree)], ["a"])

    def test_including_disabled(self):
        tree = tagtree.loads(self.TREE)
        self.assertEqual(
            [n["tag"] for n in tagtree.iter_tags(tree, only_enabled=False)], ["a", "b", "c"]
        )

    def test_inactive_area(self):
        tree = tagtree.loads(self.TREE)
        self.assertEqual([n["tag"] for n in tagtree.iter_tags(tree, "inactive")], ["d"])


class CountTagsTest(unittest.TestCase):
    def test_counts(self):
        counts = tagtree.count_tags(
            {
                "active": [
                    {"kind": "tag", "tag": "a"},
                    {"kind": "tag", "tag": "b", "on": False},
                    {"kind": "group", "name": "g", "children": [{"kind": "tag", "tag": "c"}]},
                ],
                "inactive": [{"kind": "tag", "tag": "d"}, {"kind": "tag", "tag": "e"}],
            }
        )
        self.assertEqual(counts, {"active": 2, "active_total": 3, "inactive": 2})


if __name__ == "__main__":
    unittest.main()
