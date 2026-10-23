#!/usr/bin/env python3
"""VoiceDesign 本地合成脚本（Qwen3-TTS-12Hz-1.7B-VoiceDesign）。

由 `zdcode tts design` 调用，一般不直接运行。

用法:
  python voicedesign_generate.py --text "要合成的文本" --voice "音色描述" --out out.wav

参数:
  --text      要合成的文本（必填）
  --voice     音色自然语言描述，例如「撒娇稚嫩的萝莉女声，音调偏高」（必填）
  --out       输出 WAV 路径（必填）
  --model     模型目录，默认取 $ZDCODE_VOICEDESIGN_MODEL
  --language  语言，默认 Chinese
  --device    mps | cpu，默认自动（Apple Silicon 优先 mps）
"""
import argparse
import os
import sys
import time


def main() -> int:
    parser = argparse.ArgumentParser(description="VoiceDesign local synthesis")
    parser.add_argument("--text", required=True)
    parser.add_argument("--voice", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", default=os.environ.get("ZDCODE_VOICEDESIGN_MODEL"))
    parser.add_argument("--language", default="Chinese")
    parser.add_argument("--device", default=None)
    args = parser.parse_args()

    if not args.model:
        print("[error] 未指定模型目录（--model 或 ZDCODE_VOICEDESIGN_MODEL）", file=sys.stderr)
        return 2
    if not os.path.isdir(args.model):
        print(f"[error] 模型目录不存在: {args.model}", file=sys.stderr)
        return 2

    import torch
    import soundfile as sf
    from qwen_tts import Qwen3TTSModel

    if args.device:
        device = args.device
    else:
        device = "mps" if torch.backends.mps.is_available() else "cpu"
    dtype = torch.float32 if device == "cpu" else torch.float16
    print(f"[env] device={device} dtype={dtype} torch={torch.__version__}", flush=True)

    t0 = time.time()
    model = Qwen3TTSModel.from_pretrained(args.model, device_map=device, dtype=dtype)
    print(f"[load] {time.time() - t0:.1f}s", flush=True)

    t0 = time.time()
    wavs, sr = model.generate_voice_design(
        text=args.text,
        language=args.language,
        instruct=args.voice,
    )
    dur = len(wavs[0]) / sr
    print(f"[gen] {time.time() - t0:.1f}s sr={sr} dur={dur:.2f}s", flush=True)

    out_dir = os.path.dirname(os.path.abspath(args.out))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    sf.write(args.out, wavs[0], sr)
    print(f"[done] wrote {args.out}  audio={dur:.2f}s", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
