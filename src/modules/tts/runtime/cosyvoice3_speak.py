#!/usr/bin/env python3
"""CLI 自带的 CosyVoice3 合成 runner（不依赖仓库里的 run_tts.py）。

针对 Apple Silicon 调优：LLM + FLOW 走 MPS，HIFT 留在 CPU（其 f0 需要 float64，
MPS 不支持），flow-matching 步数可调。

用法（由 `zdcode tts clone` 调用）:
  python cosyvoice3_speak.py --root <仓库根> --text "..." --out out.wav
"""
import argparse
import os
import sys
import time


def main() -> int:
    parser = argparse.ArgumentParser(description="CosyVoice3 local synthesis")
    parser.add_argument("--root", required=True, help="cosyvoice3 仓库根目录")
    parser.add_argument("--out", required=True, help="输出 WAV 路径")
    parser.add_argument("--text", default=None, help="要合成的文本")
    parser.add_argument("--text-file", default=None, help="从文件读取文本（与 --text 二选一）")
    parser.add_argument("--model", default=None, help="模型目录，默认 <root>/pretrained_models/Fun-CosyVoice3-0.5B")
    parser.add_argument("--instruct", default=None, help="风格/情绪指令，走 instruct2 模式")
    parser.add_argument("--speed", type=float, default=1.0, help="语速 0.5-2.0")
    parser.add_argument("--nfe", type=int, default=6, help="flow-matching 步数，越少越快")
    parser.add_argument("--device", default="mps", help="mps | cpu")
    parser.add_argument("--prompt-wav", default=None, help="参考音频，默认 <root>/asset/zero_shot_prompt.wav")
    parser.add_argument("--prompt-text", default=None, help="参考音频对应的文本")
    parser.add_argument("--sentence-pause-ms", type=int, default=0, help="句子间插入静音(ms)")
    parser.add_argument("--paragraph-pause-ms", type=int, default=0, help="段落间插入静音(ms)")
    args = parser.parse_args()

    root = os.path.abspath(args.root)
    if not os.path.isdir(root):
        print(f"[error] 仓库目录不存在: {root}", file=sys.stderr)
        return 2

    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    os.chdir(root)
    # 本脚本不在仓库内，sys.path[0] 是脚本目录，需要显式把仓库根加入
    sys.path.insert(0, root)
    sys.path.insert(0, os.path.join(root, "third_party", "Matcha-TTS"))

    import torch
    import torchaudio
    from cosyvoice.cli.cosyvoice import CosyVoice3

    if args.text_file:
        with open(os.path.abspath(args.text_file), encoding="utf-8") as handle:
            text = handle.read().strip()
    else:
        text = (args.text or "").strip()
    if not text:
        print("[error] 文本为空（--text 或 --text-file）", file=sys.stderr)
        return 2

    device = args.device
    if device == "mps" and not torch.backends.mps.is_available():
        device = "cpu"

    model_dir = args.model or os.path.join(root, "pretrained_models", "Fun-CosyVoice3-0.5B")
    if not os.path.isdir(model_dir):
        print(f"[error] 模型目录不存在: {model_dir}", file=sys.stderr)
        return 2

    prompt_text = args.prompt_text or "You are a helpful assistant.<|endofprompt|>希望你以后能够做的比我还好呦。"
    prompt_wav = os.path.abspath(args.prompt_wav or os.path.join(root, "asset", "zero_shot_prompt.wav"))
    instruct = (args.instruct or "").strip()

    t0 = time.time()
    cv = CosyVoice3(model_dir=model_dir)
    m = cv.model

    # --- Apple Silicon 调优 ---------------------------------------------------
    m.device = torch.device(device)
    m.llm.to(device, torch.float32)
    m.flow.to(device, torch.float32)
    m.hift.to("cpu")
    _orig_hift = m.hift.inference
    m.hift.inference = lambda speech_feat, **k: _orig_hift(speech_feat.to("cpu"), **k)

    _dec = m.flow.decoder
    _orig_fwd = _dec.forward.__func__
    _dec.forward = (lambda mu, mask, n_timesteps, *a, **k: _orig_fwd(_dec, mu, mask, args.nfe, *a, **k))
    # -------------------------------------------------------------------------
    print(f"[cfg] device(llm+flow)={device} hift=cpu nfe={args.nfe} load={time.time() - t0:.1f}s", flush=True)

    t1 = time.time()
    chunks = []
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    paragraphs = [" ".join(lines[i:i + 4]) for i in range(0, len(lines), 4)]
    sentence_pause = torch.zeros((1, int(cv.sample_rate * args.sentence_pause_ms / 1000))) if args.sentence_pause_ms else None
    paragraph_pause = torch.zeros((1, int(cv.sample_rate * args.paragraph_pause_ms / 1000))) if args.paragraph_pause_ms else None

    for paragraph_index, paragraph in enumerate(paragraphs):
        generator = (
            cv.inference_instruct2(
                paragraph,
                instruct if "<|endofprompt|>" in instruct else f"{instruct}<|endofprompt|>",
                prompt_wav,
                stream=False,
                speed=args.speed,
            )
            if instruct
            else cv.inference_zero_shot(paragraph, prompt_text, prompt_wav, stream=False, speed=args.speed)
        )
        for sentence_index, output in enumerate(generator):
            if sentence_index and sentence_pause is not None:
                chunks.append(sentence_pause)
            chunks.append(output["tts_speech"].cpu())
        if paragraph_index < len(paragraphs) - 1 and paragraph_pause is not None:
            chunks.append(paragraph_pause)

    if not chunks:
        raise RuntimeError("CosyVoice 未返回任何音频片段")

    speech = torch.cat(chunks, dim=-1)
    out = os.path.abspath(args.out)
    out_dir = os.path.dirname(out)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    torchaudio.save(out, speech, cv.sample_rate)
    dur = speech.shape[-1] / cv.sample_rate
    wall = time.time() - t1
    print(f"[done] wrote {out}  audio={dur:.1f}s  wall={wall:.1f}s  RTF={wall / dur:.2f}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
