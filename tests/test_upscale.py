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
    def setUp(self):
        self.template = upscale.load_template(upscale.DEFAULT_TEMPLATE)

    def test_prepare_prompt_replaces_exactly_the_three_workflow_inputs(self):
        with mock.patch.object(upscale.secrets, "randbelow", return_value=1234):
            prompt, prefix = upscale.prepare_prompt(
                self.template, "uploads/source.png", "new positive", "new negative"
            )

        self.assertEqual(prompt["50"]["inputs"]["image"], "uploads/source.png")
        self.assertEqual(prompt["47"]["inputs"]["text"], "new positive")
        self.assertEqual(prompt["48"]["inputs"]["text"], "new negative")
        self.assertEqual(prompt["20"]["inputs"]["seed"], 1234)
        self.assertEqual(prefix, "upscaling/%date:yyyy-MM-dd%")
        self.assertEqual(self.template["47"]["inputs"]["text"], "")

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
            self.template, uploaded, "positive", "negative"
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
            queued["prompt"]["50"]["inputs"]["image"],
            "local-comfy-ui-upscale/upscale-test.png",
        )
        self.assertEqual(queued["prompt"]["47"]["inputs"]["text"], "positive")
        self.assertEqual(queued["prompt"]["48"]["inputs"]["text"], "negative")


if __name__ == "__main__":
    unittest.main()
