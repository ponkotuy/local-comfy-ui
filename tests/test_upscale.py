import binascii
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest import mock
import zlib


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import upscale  # noqa: E402


def png_chunk(chunk_type: bytes, data: bytes) -> bytes:
    crc = binascii.crc32(chunk_type)
    crc = binascii.crc32(data, crc) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + chunk_type + data + struct.pack(">I", crc)


def make_png(text_chunks: list[tuple[bytes, bytes]]) -> bytes:
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    raw_scanline = b"\x00\x00\x00\x00"
    return b"".join(
        [
            upscale.PNG_SIGNATURE,
            png_chunk(b"IHDR", ihdr),
            *(png_chunk(kind, data) for kind, data in text_chunks),
            png_chunk(b"IDAT", zlib.compress(raw_scanline)),
            png_chunk(b"IEND", b""),
        ]
    )


def text_chunk(keyword: str, value: str) -> tuple[bytes, bytes]:
    return b"tEXt", keyword.encode("latin-1") + b"\0" + value.encode("utf-8")


def compressed_itxt_chunk(keyword: str, value: str) -> tuple[bytes, bytes]:
    data = (
        keyword.encode("latin-1")
        + b"\0"
        + b"\x01\x00"
        + b"\0"
        + b"\0"
        + zlib.compress(value.encode("utf-8"))
    )
    return b"iTXt", data


def api_prompt(positive: str = "positive", negative: str = "negative") -> dict:
    return {
        "3": {
            "inputs": {"positive": ["6", 0], "negative": ["7", 0]},
            "class_type": "KSampler",
        },
        "6": {
            "inputs": {"text": positive, "clip": ["4", 1]},
            "class_type": "CLIPTextEncode",
        },
        "7": {
            "inputs": {"text": negative, "clip": ["4", 1]},
            "class_type": "CLIPTextEncode",
        },
        "4": {"inputs": {}, "class_type": "CheckpointLoaderSimple"},
    }


def api_template(
    positive_text: str = "",
    negative_text: str = "",
    prefix: str = "fixture/output",
) -> dict:
    """A minimal API-format workflow with the shape upscale.py requires.

    prepare_prompt() locates nodes by class_type, so these tests deliberately
    number the nodes unlike workflows/upscaling-api.json: what the project's own
    template happens to contain is its business, not this test's. The bundled
    template is exercised separately by ProjectTemplateTests.
    """
    return {
        "ckpt": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": "fixture.safetensors"},
        },
        "pos": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": positive_text, "clip": ["ckpt", 1]},
        },
        "neg": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": negative_text, "clip": ["ckpt", 1]},
        },
        "load": {"class_type": "LoadImage", "inputs": {}},
        "upscale": {
            "class_type": "UltimateSDUpscale",
            "inputs": {
                "image": ["load", 0],
                "model": ["ckpt", 0],
                "positive": ["pos", 0],
                "negative": ["neg", 0],
                "seed": 0,
                "steps": 30,
                "denoise": 0.35,
            },
        },
        "save": {
            "class_type": "SaveImage",
            "inputs": {"filename_prefix": prefix, "images": ["upscale", 0]},
        },
    }


def find_node(prompt: dict, class_type: str) -> dict:
    """The first node of a class, the same way upscale.py finds them."""
    for node in prompt.values():
        if isinstance(node, dict) and node.get("class_type") == class_type:
            return node
    raise AssertionError(f"no {class_type} node in the prompt")


class FakeResponse:
    def __init__(self, value: dict):
        self.body = json.dumps(value).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self.body


class PngMetadataTests(unittest.TestCase):
    def write_png(self, payload: bytes) -> Path:
        temp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
        temp.write(payload)
        temp.close()
        self.addCleanup(Path(temp.name).unlink, missing_ok=True)
        return Path(temp.name)

    def test_extracts_multiline_unicode_prompts_from_prompt_text(self):
        prompt = api_prompt("一行目\n二行目", "低品質, 透かし")
        path = self.write_png(
            make_png([text_chunk("prompt", json.dumps(prompt, ensure_ascii=False))])
        )

        metadata = upscale.read_comfy_metadata(path)

        self.assertEqual(
            upscale.extract_prompts(metadata),
            ("一行目\n二行目", "低品質, 透かし", "6", "7", "prompt"),
        )

    def test_reads_compressed_itxt(self):
        prompt = api_prompt()
        path = self.write_png(
            make_png(
                [
                    compressed_itxt_chunk(
                        "prompt", json.dumps(prompt, ensure_ascii=False)
                    )
                ]
            )
        )

        metadata = upscale.read_comfy_metadata(path)

        self.assertIn("prompt", metadata)

    def test_falls_back_to_ui_workflow(self):
        workflow = {
            "nodes": [
                {
                    "id": 3,
                    "type": "KSampler",
                    "inputs": [
                        {"name": "positive", "link": 1},
                        {"name": "negative", "link": 2},
                    ],
                },
                {
                    "id": 6,
                    "type": "CLIPTextEncode",
                    "widgets_values": ["ui positive"],
                    "inputs": [],
                },
                {
                    "id": 7,
                    "type": "CLIPTextEncode",
                    "widgets_values": ["ui negative"],
                    "inputs": [],
                },
            ],
            "links": [
                [1, 6, 0, 3, 1, "CONDITIONING"],
                [2, 7, 0, 3, 2, "CONDITIONING"],
            ],
        }
        path = self.write_png(
            make_png([text_chunk("workflow", json.dumps(workflow))])
        )

        metadata = upscale.read_comfy_metadata(path)

        self.assertEqual(
            upscale.extract_prompts(metadata),
            ("ui positive", "ui negative", "6", "7", "workflow"),
        )

    def test_uses_first_positive_negative_pair(self):
        prompt = api_prompt("first positive", "first negative")
        prompt.update(
            {
                "8": {
                    "inputs": {"positive": ["10", 0], "negative": ["11", 0]},
                    "class_type": "FaceDetailer",
                },
                "10": {
                    "inputs": {"text": "second positive"},
                    "class_type": "CLIPTextEncode",
                },
                "11": {
                    "inputs": {"text": "second negative"},
                    "class_type": "CLIPTextEncode",
                },
            }
        )

        self.assertEqual(
            upscale.extract_from_api_prompt(prompt),
            ("first positive", "first negative", "6", "7"),
        )

    def test_rejects_png_without_comfy_metadata(self):
        path = self.write_png(make_png([]))

        with self.assertRaisesRegex(upscale.UpscaleError, "no usable ComfyUI"):
            upscale.read_comfy_metadata(path)

    def test_rejects_invalid_crc(self):
        payload = bytearray(make_png([text_chunk("prompt", "{}")]))
        payload[-1] ^= 0x01
        path = self.write_png(bytes(payload))

        with self.assertRaisesRegex(upscale.UpscaleError, "Invalid CRC"):
            upscale.read_png_text(path)


class ApiTests(unittest.TestCase):
    """What prepare_prompt() guarantees, independent of any particular template."""

    def setUp(self):
        self.template = api_template()

    def prepare(self, template=None, seed=1234, **kwargs):
        with mock.patch.object(upscale.secrets, "randbelow", return_value=seed):
            return upscale.prepare_prompt(
                template if template is not None else self.template,
                kwargs.get("image", "uploads/source.png"),
                kwargs.get("positive", "new positive"),
                kwargs.get("negative", "new negative"),
            )

    def test_fills_in_the_image_the_prompts_and_a_fresh_seed(self):
        prompt, prefix = self.prepare()

        self.assertEqual(find_node(prompt, "LoadImage")["inputs"]["image"], "uploads/source.png")
        self.assertEqual(prompt["pos"]["inputs"]["text"], "new positive")
        self.assertEqual(prompt["neg"]["inputs"]["text"], "new negative")
        self.assertEqual(find_node(prompt, "UltimateSDUpscale")["inputs"]["seed"], 1234)
        self.assertEqual(prefix, "fixture/output")

    def test_returns_whatever_prefix_the_template_carries(self):
        # The CLI reports where the result will land, so it must echo the
        # template rather than assume a particular naming scheme.
        _prompt, prefix = self.prepare(api_template(prefix="somewhere/else_%date:yyyy-MM-dd%"))
        self.assertEqual(prefix, "somewhere/else_%date:yyyy-MM-dd%")

    def test_changes_nothing_else(self):
        prompt, _prefix = self.prepare()

        expected = api_template()
        expected["load"]["inputs"]["image"] = "uploads/source.png"
        expected["pos"]["inputs"]["text"] = "new positive"
        expected["neg"]["inputs"]["text"] = "new negative"
        expected["upscale"]["inputs"]["seed"] = 1234
        self.assertEqual(prompt, expected)

    def test_leaves_the_caller_s_template_alone(self):
        self.prepare()
        self.assertEqual(self.template, api_template())

    def test_follows_the_links_rather_than_the_node_order(self):
        # positive/negative are resolved through UltimateSDUpscale's links, so
        # swapping which encoder they point at must swap the texts too.
        template = api_template()
        template["upscale"]["inputs"]["positive"] = ["neg", 0]
        template["upscale"]["inputs"]["negative"] = ["pos", 0]

        prompt, _prefix = self.prepare(template)

        self.assertEqual(prompt["neg"]["inputs"]["text"], "new positive")
        self.assertEqual(prompt["pos"]["inputs"]["text"], "new negative")

    def test_rejects_a_template_missing_a_required_node(self):
        for class_type in ("UltimateSDUpscale", "LoadImage", "SaveImage"):
            with self.subTest(class_type):
                template = api_template()
                node_id = next(k for k, v in template.items() if v["class_type"] == class_type)
                del template[node_id]

                with self.assertRaisesRegex(upscale.UpscaleError, "must contain"):
                    self.prepare(template)

    def test_rejects_an_unlinked_prompt_input(self):
        template = api_template()
        template["upscale"]["inputs"]["positive"] = "just text"

        with self.assertRaisesRegex(upscale.UpscaleError, "positive is not linked"):
            self.prepare(template)

    def test_rejects_a_prompt_input_that_does_not_reach_a_text_encoder(self):
        template = api_template()
        template["upscale"]["inputs"]["positive"] = ["ckpt", 0]

        with self.assertRaisesRegex(upscale.UpscaleError, "CLIPTextEncode"):
            self.prepare(template)

    def test_rejects_a_save_node_without_a_prefix(self):
        template = api_template()
        del template["save"]["inputs"]["filename_prefix"]

        with self.assertRaisesRegex(upscale.UpscaleError, "filename_prefix"):
            self.prepare(template)


class HttpTests(unittest.TestCase):
    @mock.patch("upscale.urllib.request.urlopen")
    def test_upload_and_queue_http_payloads(self, urlopen):
        urlopen.side_effect = [
            FakeResponse(
                {
                    "name": "upscale-test.png",
                    "subfolder": "local-comfy-ui-upscale",
                    "type": "input",
                }
            ),
            FakeResponse({"prompt_id": "prompt-123", "node_errors": {}}),
        ]
        with tempfile.NamedTemporaryFile(suffix=".png") as image:
            image.write(b"png bytes")
            image.flush()
            uploaded = upscale.upload_image("http://localhost:8188", Path(image.name))

        prompt, _prefix = upscale.prepare_prompt(
            api_template(), uploaded, "positive", "negative"
        )
        prompt_id = upscale.queue_prompt("http://localhost:8188", prompt)

        self.assertEqual(uploaded, "local-comfy-ui-upscale/upscale-test.png")
        self.assertEqual(prompt_id, "prompt-123")
        upload_request = urlopen.call_args_list[0].args[0]
        self.assertEqual(upload_request.full_url, "http://localhost:8188/upload/image")
        self.assertIn(b'name="subfolder"', upload_request.data)
        self.assertIn(b"local-comfy-ui-upscale", upload_request.data)
        queue_request = urlopen.call_args_list[1].args[0]
        queued = json.loads(queue_request.data)
        self.assertEqual(
            find_node(queued["prompt"], "LoadImage")["inputs"]["image"],
            "local-comfy-ui-upscale/upscale-test.png",
        )
        self.assertEqual(queued["prompt"]["pos"]["inputs"]["text"], "positive")
        self.assertEqual(queued["prompt"]["neg"]["inputs"]["text"], "negative")


class ProjectTemplateTests(unittest.TestCase):
    """The bundled template must keep satisfying the contract above.

    Only the contract is checked. Model names, tile sizes, denoise and the
    output prefix are settings the workflow is free to change, so asserting
    them here would just mean editing this file every time the workflow is
    re-exported from ComfyUI.
    """

    def test_bundled_template_still_works_with_the_cli(self):
        template = upscale.load_template(upscale.DEFAULT_TEMPLATE)

        with mock.patch.object(upscale.secrets, "randbelow", return_value=7):
            prompt, prefix = upscale.prepare_prompt(
                template, "uploads/source.png", "positive here", "negative here"
            )

        self.assertEqual(find_node(prompt, "LoadImage")["inputs"]["image"], "uploads/source.png")
        self.assertEqual(find_node(prompt, "UltimateSDUpscale")["inputs"]["seed"], 7)
        self.assertTrue(prefix, "the template must name an output prefix")

        # Follow the links the same way the CLI does, without caring which node
        # ids the workflow happens to use.
        upscale_inputs = find_node(prompt, "UltimateSDUpscale")["inputs"]
        texts = {
            side: prompt[str(upscale_inputs[side][0])]["inputs"]["text"]
            for side in ("positive", "negative")
        }
        self.assertEqual(texts, {"positive": "positive here", "negative": "negative here"})


if __name__ == "__main__":
    unittest.main()
