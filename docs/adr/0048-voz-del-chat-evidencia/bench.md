# Kokoro-82M latency (kokoro-onnx 0.6.1, ORT 1.31.1), 2026-11-03

Machine: i9-12900H, RTX 3060 Laptop (driver 616.92, CUDA UMD 13.4), Win11. Script: bench.py, raw data: bench.json.
Method: perf_counter, 1 warm-up, 3 timed repetitions, median per sentence. Text: 8 sentences, 123 words (ES), 125 (EN).
Each sentence is a separate `create()` call (includes phonemization). Sound quality NOT evaluated (not listened to).
Noise: another-user load was NOT zero. CPU load ~16-21 % at start (Chrome, Zoom, Okta, etc. running), so CPU
numbers are pessimistic and noisy; the README of the earlier test (RTF ~0.8) was measured on a quieter machine.
The first exploratory run was also overlapped with a venv creation and is discarded.

## CPU thread sweep (em_alex, first sentence / whole text)
| intra_op threads | time to first audio | overall RTF | max stall |
|---|---|---|---|
| default | 10.3 s | 1.99 | 9.5 s |
| 4 | 7.0 s | 1.25 | 4.6 s |
| **8 (best)** | **6.6 s** | **1.20** | 4.4 s |
| 14 | 10.5 s | 1.93 | 8.3 s |
(default/14 use P+E cores and oversubscribe against the background load; 4-8 are better.)

## CPU, 8 threads, all voices
| voice | time to first audio | overall RTF | max / total playback stall |
|---|---|---|---|
| em_alex | 6.63 s | 1.19 | 4.55 s / 6.64 s |
| ef_dora | 6.67 s | 1.27 | 3.86 s / 8.90 s |
| af_heart | 8.39 s | 1.46 | 3.92 s / 14.19 s |
Pipelined queue does NOT keep up on CPU (RTF > 1): playback stalls.

## GPU (CUDAExecutionProvider confirmed active in session.get_providers())
| voice | time to first audio | overall RTF | max stall |
|---|---|---|---|
| em_alex | 1.33 s | 0.25 | 0 |
| ef_dora | 1.20 s | 0.24 | 0 |
| af_heart | 1.37 s | 0.24 | 0 |
Per-sentence (em_alex, synth s / audio s): 1.33/5.55, 1.26/5.33, 1.18/4.27, 1.12/4.07, 0.95/3.31, 1.46/6.40, 1.37/6.29, 1.23/4.95.
Every sentence is ready long before the previous one ends: no gap (simulated sequential synthesis, playback starts when sentence 1 is ready).

## Streaming API (`Kokoro.create_stream`, async)
Exists. It splits by phoneme batches (max 510 phonemes), not by sentence: the 123-word text came out as 2 chunks, so the first chunk is large.
| backend | voice | first chunk | first chunk audio | total |
|---|---|---|---|---|
| CPU 8 thr | em_alex | 23.8 s | 18.9 s | 47.0 s |
| GPU | em_alex | 3.0 s | 18.9 s | 6.3 s |
Worse than calling `create()` per sentence for first audio. Feed it one sentence at a time instead.

## Load, memory
| | CPU | GPU |
|---|---|---|
| spawn to ready (median of 3) | 1.55 s (imports 0.4 s + load 1.0 s) | 1.69 s (imports 0.4 s + load 1.2 s) |
| peak RAM (working set) | 1376 MB | 1179 MB |
| peak VRAM | - | 2607 MB total used vs 431 MB baseline (delta ~2.2 GB, nvidia-smi polled every 0.25 s) |
Load times are with the OS file cache warm (model 325 MB); a truly cold disk read may be slower (not measured).

## GPU setup (second approach needed)
1. Python 3.12 venv `.venv-gpu`, kokoro-onnx 0.6.1 + onnxruntime-gpu 1.31.1 + nvidia-*-cu12 wheels: FAILED. Error: `onnxruntime_providers_cuda.dll depends on cublasLt64_13.dll which is missing`
   (this ORT build needs CUDA 13 + cuDNN 9); fell back silently to CPU.
2. Installed CUDA 13 wheels (nvidia-cudnn-cu13, nvidia-cublas, nvidia-cuda-runtime, nvidia-cufft, nvidia-curand, nvidia-cuda-nvrtc, nvidia-nvjitlink) and put their DLL dirs on PATH of the child process only: works.
Run GPU with `bench.py gpu` (adds the DLL dirs to PATH only for the child process; nothing global).
Warnings seen: 17 Memcpy nodes on CUDA EP (some ops stay on CPU); harmless for correctness here, not investigated.
