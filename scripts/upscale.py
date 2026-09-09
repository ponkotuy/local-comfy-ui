#!/usr/bin/env python3
"""Queue the project's upscaling workflow using prompts embedded in a PNG."""

from __future__ import annotations

import argparse
import binascii
import copy
import json
import os
from pathlib import Path
import secrets
import struct
import sys
from typing import Any, Iterator
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zlib


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_TEMPLATE = PROJECT_ROOT / "workflows" / "upscaling-api.json"
MAX_CHUNK_SIZE = 256 * 1024 * 1024


class UpscaleError(Exception):
    """An expected error that should be shown without a traceback."""


def _decode_latin1_json_text(data: bytes) -> str:
    """Decode PNG latin-1 text while accepting UTF-8 written by lenient tools."""
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("latin-1")


def _parse_text_chunk(chunk_type: bytes, data: bytes) -> tuple[str, str] | None:
    try:
        if chunk_type == b"tEXt":
            keyword, value = data.split(b"\0", 1)
            return keyword.decode("latin-1"), _decode_latin1_json_text(value)

        if chunk_type == b"zTXt":
            keyword, rest = data.split(b"\0", 1)
            if not rest or rest[0] != 0:
                raise UpscaleError("Unsupported PNG zTXt compression method")
            value = zlib.decompress(rest[1:])
            return keyword.decode("latin-1"), _decode_latin1_json_text(value)

        if chunk_type == b"iTXt":
            keyword, rest = data.split(b"\0", 1)
            if len(rest) < 2:
                raise UpscaleError("Malformed PNG iTXt chunk")
            compressed, compression_method = rest[0], rest[1]
            rest = rest[2:]
            _language, rest = rest.split(b"\0", 1)
            _translated_keyword, value = rest.split(b"\0", 1)
            if compressed:
                if compression_method != 0:
                    raise UpscaleError("Unsupported PNG iTXt compression method")
                value = zlib.decompress(value)
            return keyword.decode("latin-1"), value.decode("utf-8")
    except (ValueError, UnicodeDecodeError, zlib.error) as exc:
        raise UpscaleError(f"Malformed PNG {chunk_type.decode('ascii')} chunk: {exc}") from exc

    return None


def read_png_text(path: Path) -> dict[str, str]:
    """Return textual metadata from a PNG, validating its chunk framing and CRCs."""
    metadata: dict[str, str] = {}

    try:
        png = path.open("rb")
    except OSError as exc:
        raise UpscaleError(f"Cannot open PNG: {exc}") from exc

    with png:
        if png.read(len(PNG_SIGNATURE)) != PNG_SIGNATURE:
            raise UpscaleError(f"Not a PNG file: {path}")

        saw_iend = False
        while True:
            header = png.read(8)
            if not header:
                break
            if len(header) != 8:
                raise UpscaleError("Truncated PNG chunk header")

            length, chunk_type = struct.unpack(">I4s", header)
            if length > MAX_CHUNK_SIZE:
                raise UpscaleError(f"PNG chunk is too large: {length} bytes")
            data = png.read(length)
            crc_bytes = png.read(4)
            if len(data) != length or len(crc_bytes) != 4:
                raise UpscaleError("Truncated PNG chunk")

            expected_crc = struct.unpack(">I", crc_bytes)[0]
            actual_crc = binascii.crc32(chunk_type)
            actual_crc = binascii.crc32(data, actual_crc) & 0xFFFFFFFF
            if actual_crc != expected_crc:
                raise UpscaleError(
                    f"Invalid CRC for PNG {chunk_type.decode('ascii', errors='replace')} chunk"
                )

            parsed = _parse_text_chunk(chunk_type, data)
            if parsed is not None:
                keyword, value = parsed
                metadata[keyword] = value

            if chunk_type == b"IEND":
                saw_iend = True
                break

        if not saw_iend:
            raise UpscaleError("PNG is missing its IEND chunk")

    return metadata


def read_comfy_metadata(path: Path) -> dict[str, Any]:
    text = read_png_text(path)
    result: dict[str, Any] = {}
    malformed: list[str] = []

    for key in ("prompt", "workflow"):
        if key not in text:
            continue
        try:
            value = json.loads(text[key])
        except json.JSONDecodeError as exc:
            malformed.append(f"{key}: {exc}")
            continue
        if isinstance(value, dict):
            result[key] = value
        else:
            malformed.append(f"{key}: top-level JSON value is not an object")

    if not result:
        detail = f" ({'; '.join(malformed)})" if malformed else ""
        raise UpscaleError(f"PNG has no usable ComfyUI prompt/workflow metadata{detail}")
    return result


def _is_link(value: Any) -> bool:
    return (
        isinstance(value, list)
        and len(value) == 2
        and isinstance(value[0], (str, int))
        and isinstance(value[1], int)
    )


def _api_node(nodes: dict[str, Any], node_id: str | int) -> dict[str, Any]:
    node = nodes.get(str(node_id))
    if not isinstance(node, dict):
        raise UpscaleError(f"Prompt references missing node {node_id}")
    return node


def _resolve_api_text(
    nodes: dict[str, Any], reference: Any, visited: set[str] | None = None
) -> tuple[str, str]:
    if not _is_link(reference):
        raise UpscaleError(f"Conditioning input is not a node link: {reference!r}")

    node_id = str(reference[0])
    visited = set() if visited is None else visited
    if node_id in visited:
        raise UpscaleError(f"Cycle detected while resolving prompt at node {node_id}")
    visited.add(node_id)

    node = _api_node(nodes, node_id)
    inputs = node.get("inputs", {})
    if not isinstance(inputs, dict):
        raise UpscaleError(f"Node {node_id} has invalid inputs")
    class_type = str(node.get("class_type", ""))

    if class_type.startswith("CLIPTextEncode"):
        text = inputs.get("text")
        if isinstance(text, str):
            return text, node_id
        if _is_link(text):
            return _resolve_api_text(nodes, text, visited)

    for value in inputs.values():
        if _is_link(value):
            try:
                return _resolve_api_text(nodes, value, visited.copy())
            except UpscaleError:
                continue

    if "String" in class_type or "Text" in class_type:
        for name in ("text", "value", "string"):
            value = inputs.get(name)
            if isinstance(value, str):
                return value, node_id

    raise UpscaleError(f"Could not resolve prompt text upstream of node {node_id}")


def extract_from_api_prompt(prompt: dict[str, Any]) -> tuple[str, str, str, str]:
    for source_id, raw_node in prompt.items():
        if not isinstance(raw_node, dict):
            continue
        inputs = raw_node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        if "positive" not in inputs or "negative" not in inputs:
            continue
        try:
            positive, positive_id = _resolve_api_text(prompt, inputs["positive"])
            negative, negative_id = _resolve_api_text(prompt, inputs["negative"])
        except UpscaleError as exc:
            raise UpscaleError(
                f"The first positive/negative pair at prompt node {source_id} "
                f"could not be resolved: {exc}"
            ) from exc
        return positive, negative, positive_id, negative_id

    raise UpscaleError("No node with positive and negative inputs was found in prompt metadata")


def _ui_links(workflow: dict[str, Any]) -> dict[int, list[Any]]:
    links: dict[int, list[Any]] = {}
    for link in workflow.get("links", []):
        if isinstance(link, list) and len(link) >= 6 and isinstance(link[0], int):
            links[link[0]] = link
    return links


def _ui_nodes(workflow: dict[str, Any]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for node in workflow.get("nodes", []):
        if isinstance(node, dict) and isinstance(node.get("id"), (str, int)):
            result[str(node["id"])] = node
    return result


def _resolve_ui_text(
    nodes: dict[str, dict[str, Any]],
    links: dict[int, list[Any]],
    link_id: Any,
    visited: set[str] | None = None,
) -> tuple[str, str]:
    if not isinstance(link_id, int) or link_id not in links:
        raise UpscaleError(f"Workflow references missing link {link_id!r}")
    source_id = str(links[link_id][1])
    node = nodes.get(source_id)
    if node is None:
        raise UpscaleError(f"Workflow link references missing node {source_id}")

    visited = set() if visited is None else visited
    if source_id in visited:
        raise UpscaleError(f"Cycle detected while resolving workflow node {source_id}")
    visited.add(source_id)

    node_type = str(node.get("type", ""))
    if node_type.startswith("CLIPTextEncode"):
        values = node.get("widgets_values")
        if isinstance(values, list):
            for value in values:
                if isinstance(value, str):
                    return value, source_id

    for node_input in node.get("inputs", []):
        if isinstance(node_input, dict) and isinstance(node_input.get("link"), int):
            try:
                return _resolve_ui_text(nodes, links, node_input["link"], visited.copy())
            except UpscaleError:
                continue

    raise UpscaleError(f"Could not resolve prompt text upstream of workflow node {source_id}")


def extract_from_ui_workflow(workflow: dict[str, Any]) -> tuple[str, str, str, str]:
    nodes = _ui_nodes(workflow)
    links = _ui_links(workflow)

    for raw_node in workflow.get("nodes", []):
        if not isinstance(raw_node, dict):
            continue
        inputs = raw_node.get("inputs")
        if not isinstance(inputs, list):
            continue
        by_name = {
            item.get("name"): item
            for item in inputs
            if isinstance(item, dict) and isinstance(item.get("name"), str)
        }
        if "positive" not in by_name or "negative" not in by_name:
            continue
        try:
            positive, positive_id = _resolve_ui_text(
                nodes, links, by_name["positive"].get("link")
            )
            negative, negative_id = _resolve_ui_text(
                nodes, links, by_name["negative"].get("link")
            )
        except UpscaleError as exc:
            raise UpscaleError(
                f"The first positive/negative pair at workflow node "
                f"{raw_node.get('id', '?')} could not be resolved: {exc}"
            ) from exc
        return positive, negative, positive_id, negative_id

    raise UpscaleError("No node with positive and negative inputs was found in workflow metadata")


def extract_prompts(metadata: dict[str, Any]) -> tuple[str, str, str, str, str]:
    if "prompt" in metadata:
        positive, negative, positive_id, negative_id = extract_from_api_prompt(
            metadata["prompt"]
        )
        return positive, negative, positive_id, negative_id, "prompt"

    positive, negative, positive_id, negative_id = extract_from_ui_workflow(
        metadata["workflow"]
    )
    return positive, negative, positive_id, negative_id, "workflow"


def build_multipart(fields: dict[str, str], file_path: Path) -> tuple[bytes, str]:
    boundary = f"----local-comfy-ui-{uuid.uuid4().hex}"
    body = bytearray()

    for name, value in fields.items():
        body.extend(f"--{boundary}\r\n".encode("ascii"))
        body.extend(
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("ascii")
        )
        body.extend(value.encode("utf-8"))
        body.extend(b"\r\n")

    remote_name = f"upscale-{uuid.uuid4().hex}.png"
    body.extend(f"--{boundary}\r\n".encode("ascii"))
    body.extend(
        (
            f'Content-Disposition: form-data; name="image"; filename="{remote_name}"\r\n'
            "Content-Type: image/png\r\n\r\n"
        ).encode("ascii")
    )
    try:
        body.extend(file_path.read_bytes())
    except OSError as exc:
        raise UpscaleError(f"Cannot read PNG for upload: {exc}") from exc
    body.extend(f"\r\n--{boundary}--\r\n".encode("ascii"))
    return bytes(body), boundary


def _request_json(request: urllib.request.Request) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode("utf-8", errors="replace")
        except OSError:
            detail = str(exc)
        raise UpscaleError(f"ComfyUI returned HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise UpscaleError(f"Could not connect to ComfyUI: {exc.reason}") from exc
    except TimeoutError as exc:
        raise UpscaleError("Timed out while connecting to ComfyUI") from exc

    try:
        result = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise UpscaleError(f"ComfyUI returned invalid JSON: {exc}") from exc
    if not isinstance(result, dict):
        raise UpscaleError("ComfyUI returned a non-object JSON response")
    return result


def _server_url(server: str) -> str:
    server = server.rstrip("/")
    parsed = urllib.parse.urlparse(server)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise UpscaleError(f"Invalid ComfyUI server URL: {server}")
    return server


def upload_image(server: str, path: Path) -> str:
    body, boundary = build_multipart(
        {"type": "input", "subfolder": "local-comfy-ui-upscale", "overwrite": "false"},
        path,
    )
    request = urllib.request.Request(
        f"{_server_url(server)}/upload/image",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    result = _request_json(request)
    name = result.get("name")
    subfolder = result.get("subfolder", "")
    image_type = result.get("type", "input")
    if not isinstance(name, str) or not name:
        raise UpscaleError(f"Upload response has no image name: {result}")
    if image_type != "input":
        raise UpscaleError(f"ComfyUI uploaded the image as unexpected type {image_type!r}")
    if not isinstance(subfolder, str):
        raise UpscaleError(f"Upload response has an invalid subfolder: {result}")
    return f"{subfolder.rstrip('/')}/{name}" if subfolder else name


def load_template(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise UpscaleError(f"Cannot read API workflow template: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise UpscaleError(f"Invalid API workflow template JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise UpscaleError("API workflow template must be a JSON object")
    return value


def _iter_nodes_by_type(
    prompt: dict[str, Any], class_type: str
) -> Iterator[tuple[str, dict[str, Any]]]:
    for node_id, node in prompt.items():
        if isinstance(node, dict) and node.get("class_type") == class_type:
            yield str(node_id), node


def prepare_prompt(
    template: dict[str, Any], image_name: str, positive: str, negative: str
) -> tuple[dict[str, Any], str]:
    prompt = copy.deepcopy(template)
    try:
        _upscale_id, upscale = next(_iter_nodes_by_type(prompt, "UltimateSDUpscale"))
        _image_id, image_node = next(_iter_nodes_by_type(prompt, "LoadImage"))
        _save_id, save_node = next(_iter_nodes_by_type(prompt, "SaveImage"))
    except StopIteration as exc:
        raise UpscaleError(
            "API workflow template must contain UltimateSDUpscale, LoadImage, and SaveImage"
        ) from exc

    inputs = upscale.get("inputs")
    if not isinstance(inputs, dict):
        raise UpscaleError("UltimateSDUpscale has invalid inputs in the API template")
    for name in ("positive", "negative"):
        if not _is_link(inputs.get(name)):
            raise UpscaleError(f"UltimateSDUpscale.{name} is not linked in the API template")

    positive_node = _api_node(prompt, inputs["positive"][0])
    negative_node = _api_node(prompt, inputs["negative"][0])
    if not str(positive_node.get("class_type", "")).startswith("CLIPTextEncode") or not str(
        negative_node.get("class_type", "")
    ).startswith("CLIPTextEncode"):
        raise UpscaleError(
            "UltimateSDUpscale positive/negative must link directly to CLIPTextEncode nodes"
        )
    if not isinstance(positive_node.get("inputs"), dict) or not isinstance(
        negative_node.get("inputs"), dict
    ):
        raise UpscaleError("Prompt encoder has invalid inputs in the API template")

    image_node.setdefault("inputs", {})["image"] = image_name
    positive_node["inputs"]["text"] = positive
    negative_node["inputs"]["text"] = negative
    inputs["seed"] = secrets.randbelow(2**50)

    save_inputs = save_node.get("inputs")
    prefix = save_inputs.get("filename_prefix") if isinstance(save_inputs, dict) else None
    if not isinstance(prefix, str) or not prefix:
        raise UpscaleError("SaveImage has no filename_prefix in the API template")
    return prompt, prefix


def queue_prompt(server: str, prompt: dict[str, Any]) -> str:
    payload = json.dumps(
        {"prompt": prompt, "client_id": str(uuid.uuid4())}, ensure_ascii=False
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{_server_url(server)}/prompt",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    result = _request_json(request)
    prompt_id = result.get("prompt_id")
    if not isinstance(prompt_id, str) or not prompt_id:
        node_errors = result.get("node_errors")
        detail = f"; node_errors={node_errors}" if node_errors else ""
        raise UpscaleError(f"ComfyUI did not return a prompt_id{detail}")
    return prompt_id


def default_server() -> str:
    if os.environ.get("COMFYUI_URL"):
        return os.environ["COMFYUI_URL"]
    port = os.environ.get("COMFYUI_PORT", "8188")
    return f"http://127.0.0.1:{port}"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Queue upscaling using prompts embedded in a ComfyUI PNG."
    )
    parser.add_argument("png_file", type=Path, help="ComfyUI-generated PNG to upscale")
    parser.add_argument(
        "--server",
        default=default_server(),
        help="ComfyUI base URL (default: COMFYUI_URL or localhost:COMFYUI_PORT)",
    )
    parser.add_argument(
        "--template",
        type=Path,
        default=DEFAULT_TEMPLATE,
        help=argparse.SUPPRESS,
    )
    return parser.parse_args(argv)


def run(args: argparse.Namespace) -> int:
    path = args.png_file.expanduser().resolve()
    if not path.is_file():
        raise UpscaleError(f"PNG file does not exist: {path}")
    if path.suffix.lower() != ".png":
        raise UpscaleError(f"Input file must have a .png extension: {path}")

    metadata = read_comfy_metadata(path)
    positive, negative, positive_id, negative_id, source = extract_prompts(metadata)

    print(f"Metadata source: {source}")
    print(f"Positive node: {positive_id}")
    print("Positive prompt:")
    print(positive)
    print(f"Negative node: {negative_id}")
    print("Negative prompt:")
    print(negative)

    template = load_template(args.template)
    prompt, output_prefix = prepare_prompt(
        template, "__pending_upload__.png", positive, negative
    )
    image_name = upload_image(args.server, path)
    _image_id, image_node = next(_iter_nodes_by_type(prompt, "LoadImage"))
    image_node["inputs"]["image"] = image_name
    prompt_id = queue_prompt(args.server, prompt)

    print(f"Queued prompt_id: {prompt_id}")
    print(f"Expected output: data/output/{output_prefix}...")
    return 0


def main(argv: list[str] | None = None) -> int:
    try:
        return run(parse_args(argv))
    except UpscaleError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
