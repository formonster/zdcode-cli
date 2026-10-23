#!/usr/bin/env python3
"""Stable Audio Open 本地音频生成（Small / 1.0）。"""
import argparse
import json
import os
import time
import wave

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import numpy as np
import torch
from einops import rearrange
from safetensors import safe_open

from stable_audio_tools.inference.generation import generate_diffusion_cond
from stable_audio_tools.models.factory import create_model_from_config

SMALL_MODEL_ID = "joeriben/stable-audio-open-small"
DEFAULT_1_0_DIR = os.path.join(os.path.expanduser("~"), ".zdcode", "models", "stable-audio-open-1.0")


def patch_mps_apg() -> None:
    """stable-audio-tools 的 APG 默认用 float64，MPS 不支持；这里在运行时替换为 float32。"""
    from stable_audio_tools.models.dit import DiffusionTransformer

    if getattr(DiffusionTransformer.apg_project, "_zdcode_patched", False):
        return

    def apg_project(self, v0, v1, padding_mask=None):
        dtype = v0.dtype
        use_dtype = torch.float32 if v0.is_mps else torch.float64
        v0, v1 = v0.to(use_dtype), v1.to(use_dtype)

        if padding_mask is not None:
            mask = padding_mask.unsqueeze(1).to(use_dtype)
            v0_masked = v0 * mask
            v1_masked = v1 * mask
            v1_norm = v1_masked.norm(dim=[-1, -2], keepdim=True).clamp(min=1e-8)
            v1_normalized = v1_masked / v1_norm
            v0_parallel = (v0_masked * v1_normalized).sum(dim=[-1, -2], keepdim=True) * v1_normalized
            v0_orthogonal = (v0 - (v0 * v1_normalized).sum(dim=[-1, -2], keepdim=True) * v1_normalized) * mask
        else:
            v1 = torch.nn.functional.normalize(v1, dim=[-1, -2])
            v0_parallel = (v0 * v1).sum(dim=[-1, -2], keepdim=True) * v1
            v0_orthogonal = v0 - v0_parallel

        return v0_parallel.to(dtype), v0_orthogonal.to(dtype)

    apg_project._zdcode_patched = True
    DiffusionTransformer.apg_project = apg_project


def load_small():
    from stable_audio_tools import get_pretrained_model

    model, config = get_pretrained_model(SMALL_MODEL_ID)
    return model, config


def load_1_0(model_dir: str, half: bool):
    config_path = os.path.join(model_dir, "model_config.json")
    weights_path = os.path.join(model_dir, "model.safetensors")
    if not os.path.isfile(config_path) or not os.path.isfile(weights_path):
        raise SystemExit(
            f"找不到 Stable Audio Open 1.0 权重：{model_dir}\n"
            "请把 model_config.json 和 model.safetensors 放到该目录，"
            "或用 ZDCODE_AUDIO_MODEL_DIR 指定目录。"
        )

    with open(config_path, "r", encoding="utf-8") as handle:
        config = json.load(handle)

    start = time.time()
    model = create_model_from_config(config)
    if half:
        model.model.half()  # 只对 DiT 用 fp16，VAE/T5 保持 fp32
    print(f"init {time.time() - start:.1f}s", flush=True)

    state = model.state_dict()
    start = time.time()
    loaded = 0
    with safe_open(weights_path, framework="pt") as handle:
        for key in handle.keys():
            if key not in state:
                continue
            tensor = handle.get_tensor(key)
            if state[key].dtype == torch.float16:
                tensor = tensor.half()
            state[key].copy_(tensor)
            loaded += 1
    print(f"load {loaded} tensors {time.time() - start:.1f}s", flush=True)
    return model, config


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("prompt")
    parser.add_argument("--model", choices=["1.0", "small"], default="1.0")
    parser.add_argument("--out", required=True)
    parser.add_argument("--seconds", type=float, default=47.0)
    parser.add_argument("--steps", type=int, default=100)
    parser.add_argument("--cfg", type=float, default=7.0)
    parser.add_argument("--seed", type=int, default=-1)
    parser.add_argument("--device", choices=["mps", "cpu"], default="mps")
    args = parser.parse_args()

    patch_mps_apg()

    use_mps = args.device == "mps" and torch.backends.mps.is_available()
    device = "mps" if use_mps else "cpu"

    start = time.time()
    if args.model == "small":
        model, config = load_small()
    else:
        model_dir = os.environ.get("ZDCODE_AUDIO_MODEL_DIR", DEFAULT_1_0_DIR)
        model, config = load_1_0(model_dir, half=use_mps)
    sample_rate = config["sample_rate"]
    max_seconds = config["sample_size"] / sample_rate
    if args.seconds > max_seconds + 0.01:
        raise SystemExit(f"{args.model} 模型最长支持 {max_seconds:.2f} 秒，当前请求 {args.seconds:g} 秒。")

    model = model.to(device).eval()
    print(f"model ready {time.time() - start:.1f}s, device={device}", flush=True)

    sample_size = min(int(args.seconds * sample_rate), config["sample_size"])
    sampler = "pingpong" if args.model == "small" else "dpmpp-3m-sde"

    start = time.time()
    with torch.inference_mode():
        output = generate_diffusion_cond(
            model,
            steps=args.steps,
            cfg_scale=args.cfg,
            conditioning=[{
                "prompt": args.prompt,
                "seconds_start": 0,
                "seconds_total": args.seconds,
            }],
            sample_size=sample_size,
            sampler_type=sampler,
            device=device,
            seed=args.seed,
        )
    print(f"generated {time.time() - start:.1f}s", flush=True)

    output = rearrange(output, "b d n -> d (b n)")
    output = output.to(torch.float32).div(torch.max(torch.abs(output))).clamp(-1, 1).mul(32767).to(torch.int16).cpu()

    out_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(out_dir, exist_ok=True)
    with wave.open(args.out, "wb") as handle:
        handle.setnchannels(output.shape[0])
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(output.numpy().T.tobytes())
    print(f"saved {args.out} ({output.shape[-1] / sample_rate:.2f}s, {sample_rate}Hz)", flush=True)


if __name__ == "__main__":
    main()
