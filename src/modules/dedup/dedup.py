#!/usr/bin/env python3
"""
关键帧去重引擎

策略：
1. dHash 快速粗筛 — 汉明距离 <= threshold 的判定为冗余
2. (可选) VLM 复核 — 距离在 gray zone 的帧交给 minicpm-v 判断

用法:
  python3 dedup.py /path/to/frames --threshold 5 --vlm --dry-run
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path
from typing import Any

from PIL import Image
import imagehash
import requests

OLLAMA_URL = "http://localhost:11434/api/generate"
VLM_MODEL = "minicpm-v:latest"
VLM_TIMEOUT = 30  # seconds per comparison

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff", ".tif"}

VLM_PROMPT = """You are comparing two consecutive video keyframes to detect redundancy.

Frame A is the last KEPT keyframe. Frame B is the candidate.

Determine if Frame B contains SIGNIFICANT new visual information not present in Frame A.

Reply with ONLY one word: YES (Frame B has meaningful new content — keep it) or NO (Frame B is redundant — can be deleted).

New information includes: a new scene, a new person entering, a major object change, a significant camera movement revealing new content, a slide transition, or new text appearing.

NOT considered new information: slight brightness change, encoding artifacts, subtitles moving one line, minor facial expression change, or camera micro-movement (< 5% frame shift).

Frame A: [FIRST IMAGE]
Frame B: [SECOND IMAGE]

Your answer (YES or NO only):"""


def is_image(path: Path) -> bool:
    return path.suffix.lower() in IMAGE_EXTS


def collect_images(folder: Path) -> list[Path]:
    files = sorted(
        p for p in folder.iterdir()
        if p.is_file() and is_image(p)
    )
    if not files:
        print(json.dumps({"error": f"未找到图片文件: {folder}"}, ensure_ascii=False))
        sys.exit(1)
    return files


def image_to_base64(path: Path) -> str:
    """Read image and return base64 data URL string."""
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


def compute_all_hashes(paths: list[Path], quiet: bool = False) -> dict[str, imagehash.ImageHash]:
    """Compute dHash for all images. dHash is fast and good at detecting structural changes."""
    hashes: dict[str, imagehash.ImageHash] = {}
    total = len(paths)
    for i, p in enumerate(paths):
        try:
            img = Image.open(p).convert("L")  # grayscale for speed
            hashes[str(p)] = imagehash.dhash(img)
        except Exception as e:
            print(f"⚠️  跳过 {p.name}: {e}", file=sys.stderr)
        if not quiet and (i + 1) % 10 == 0:
            print(f"\r🔍 哈希计算: {i + 1}/{total}", end="", file=sys.stderr)
    if not quiet:
        print(f"\r✅ 哈希计算完成: {len(hashes)}/{total} 张图片", file=sys.stderr)
    return hashes


def ask_vlm(frame_a: Path, frame_b: Path, quiet: bool = False) -> bool:
    """
    Ask minicpm-v if Frame B has significant new content.
    Returns True if should KEEP (has new info), False if redundant.
    """
    # minicpm-v uses the "images" field in ollama generate API
    b64_a = image_to_base64(frame_a)
    b64_b = image_to_base64(frame_b)

    payload = {
        "model": VLM_MODEL,
        "prompt": VLM_PROMPT,
        "images": [b64_a, b64_b],
        "stream": False,
    }

    try:
        resp = requests.post(OLLAMA_URL, json=payload, timeout=VLM_TIMEOUT)
        resp.raise_for_status()
        answer = resp.json().get("response", "").strip().upper()
        if not quiet:
            mark = "✅ KEEP" if answer.startswith("YES") else "🗑️  DROP"
            print(f"   VLM [{frame_a.name} vs {frame_b.name}]: {mark}", file=sys.stderr)
        return answer.startswith("YES")
    except Exception as e:
        # On VLM failure, fall back to keeping the frame (safe default)
        if not quiet:
            print(f"   ⚠️  VLM 调用失败 ({frame_a.name} vs {frame_b.name}): {e}，默认保留", file=sys.stderr)
        return True


def dedup(
    folder: Path,
    threshold: int = 5,
    vlm: bool = False,
    vlm_threshold: int = 3,
    dry_run: bool = False,
    quiet: bool = False,
) -> dict[str, Any]:
    """
    Deduplicate images in folder.

    Args:
        folder: Path to folder containing images
        threshold: Hamming distance threshold for dHash (0-64). Below = redundant.
        vlm: Enable VLM fallback for gray zone comparisons
        vlm_threshold: Max distance that triggers VLM (only when vlm=True).
                       Distances <= vlm_threshold are auto-skipped,
                       distances > threshold are auto-kept,
                       distances in (vlm_threshold, threshold] are VLM-reviewed.
        dry_run: If True, don't actually delete files
        quiet: Suppress progress output
    """
    images = collect_images(folder)
    hashes = compute_all_hashes(images, quiet=quiet)

    if len(hashes) < 2:
        return {
            "total": len(hashes),
            "kept": len(hashes),
            "deleted": 0,
            "vlm_consulted": 0,
            "files": [{"name": images[0].name, "action": "keep", "reason": "唯一的图片"}],
        }

    files: list[dict[str, Any]] = []
    kept_count = 0
    deleted_count = 0
    vlm_count = 0

    # First image is always kept
    last_kept_key = str(images[0])
    last_kept_hash = hashes[last_kept_key]
    files.append({"name": images[0].name, "action": "keep", "reason": "第一帧"})
    kept_count += 1

    for i in range(1, len(images)):
        current_key = str(images[i])
        current_hash = hashes.get(current_key)
        if current_hash is None:
            continue  # skipped due to read error

        distance = last_kept_hash - current_hash

        if distance <= threshold:
            # Within threshold — potentially redundant
            if vlm and vlm_threshold < distance <= threshold:
                # Gray zone — ask VLM
                vlm_count += 1
                should_keep = ask_vlm(images[i - 1], images[i], quiet=quiet)
                if should_keep:
                    files.append({
                        "name": images[i].name,
                        "action": "keep",
                        "reason": f"VLM判定有新信息 (dHash distance={distance})",
                        "distance": distance,
                    })
                    last_kept_hash = current_hash
                    last_kept_key = current_key
                    kept_count += 1
                else:
                    files.append({
                        "name": images[i].name,
                        "action": "delete" if not dry_run else "would_delete",
                        "reason": f"VLM判定冗余 (dHash distance={distance})",
                        "distance": distance,
                    })
                    deleted_count += 1
                    if not dry_run:
                        images[i].unlink()
            else:
                # Below threshold, auto-delete
                files.append({
                    "name": images[i].name,
                    "action": "delete" if not dry_run else "would_delete",
                    "reason": f"dHash 冗余 (distance={distance} <= {threshold})",
                    "distance": distance,
                })
                deleted_count += 1
                if not dry_run:
                    images[i].unlink()
        else:
            # Above threshold — keep
            files.append({
                "name": images[i].name,
                "action": "keep",
                "reason": f"dHash 差异足够 (distance={distance} > {threshold})",
                "distance": distance,
            })
            last_kept_hash = current_hash
            last_kept_key = current_key
            kept_count += 1

    result = {
        "total": len(images),
        "kept": kept_count,
        "deleted": deleted_count,
        "vlm_consulted": vlm_count,
        "mode": "dry_run" if dry_run else "live",
        "files": files,
    }

    return result


def main() -> None:
    parser = argparse.ArgumentParser(
        description="关键帧去重 — 基于 dHash + 可选 VLM (minicpm-v) 复核",
    )
    parser.add_argument(
        "folder",
        type=Path,
        help="图片文件夹路径",
    )
    parser.add_argument(
        "--threshold",
        type=int,
        default=5,
        help="dHash 汉明距离阈值 (0-64, 默认 5)。低于此值判定为冗余",
    )
    parser.add_argument(
        "--vlm",
        action="store_true",
        help="启用 VLM 复核（使用本地 minicpm-v 模型）",
    )
    parser.add_argument(
        "--vlm-threshold",
        type=int,
        default=3,
        help="VLM 复核的灰区上限 (默认 3)。距离在 (vlm-threshold, threshold] 之间时咨询 VLM",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="仅预览，不实际删除文件",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="抑制进度输出（仅输出最终 JSON）",
    )

    args = parser.parse_args()

    folder: Path = args.folder.resolve()
    if not folder.is_dir():
        print(json.dumps({"error": f"文件夹不存在: {folder}"}, ensure_ascii=False))
        sys.exit(1)

    result = dedup(
        folder=folder,
        threshold=args.threshold,
        vlm=args.vlm,
        vlm_threshold=args.vlm_threshold,
        dry_run=args.dry_run,
        quiet=args.quiet,
    )

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
