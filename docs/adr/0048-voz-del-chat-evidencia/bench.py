"""Kokoro-82M latency benchmark (kokoro-onnx 0.6.1). Stdlib orchestrator + worker.
Usage:
  python bench.py all                      # CPU sweep + best config (uses .venv); GPU: bench.py gpu (uses .venv-gpu)
  python bench.py worker --cfg cpu --threads 8 --voices em_alex --reps 3
Worker prints one JSON line prefixed with RESULT=.
"""
import sys, os, time, json, argparse, subprocess, statistics as st, ctypes, ctypes.wintypes as wt, threading

T0 = time.perf_counter()
HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, "models", "kokoro-v1.0.onnx")
VOICES = os.path.join(HERE, "models", "voices-v1.0.bin")

ES = ["Hola, te cuento cómo quedó el arreglo del fallo de sincronización que veníamos viendo desde el lunes.",
      "El problema era que la cola de mensajes se vaciaba dos veces cuando la conexión se reiniciaba.",
      "Ya corregí esa condición de carrera y añadí una prueba que la reproduce.",
      "Las ciento veinte pruebas del proyecto pasan sin errores en mi máquina.",
      "Falta confirmar un detalle antes de publicar el cambio.",
      "Si subimos la corrección hoy mismo, tendremos que aplazar la migración de la base de datos hasta la semana que viene.",
      "Por otro lado, esperar a mañana nos deja revisar todo con calma, pero los usuarios seguirían viendo el error.",
      "Necesito que me digas qué prefieres: publicar ahora o esperar a la revisión de mañana."]
EN = ["Hi, let me tell you how the synchronization bug fix turned out, the one we have been chasing since Monday.",
      "The problem was that the message queue was emptied twice whenever the connection restarted.",
      "I already fixed that race condition and added a test that reproduces it.",
      "All one hundred and twenty tests in the project pass without errors on my machine.",
      "One detail is still missing before we publish the change.",
      "If we ship the fix today, we will have to postpone the database migration until next week.",
      "On the other hand, waiting until tomorrow lets us review everything calmly, but users would keep seeing the error.",
      "I need you to tell me what you prefer: publish now, or wait for the review tomorrow."]


def peak_rss_mb():
    class PMC(ctypes.Structure):
        _fields_ = [("cb", wt.DWORD), ("PageFaultCount", wt.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t)]
    p = PMC(); p.cb = ctypes.sizeof(p)
    k32 = ctypes.windll.kernel32; k32.GetCurrentProcess.restype = wt.HANDLE
    ctypes.windll.psapi.GetProcessMemoryInfo(wt.HANDLE(k32.GetCurrentProcess()), ctypes.byref(p), p.cb)
    return p.PeakWorkingSetSize / 2**20


def vram_used():
    try:
        o = subprocess.check_output(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], text=True)
        return int(o.strip().splitlines()[0])
    except Exception:
        return None


def timeline(synth, audio):
    """Sequential synthesizer; playback starts when sentence 0 is ready. Returns ready times, gaps, end."""
    ready, t = [], 0.0
    for s in synth:
        t += s; ready.append(t)
    end, gaps = ready[0], []
    for i in range(len(audio)):
        start = max(end, ready[i]) if i else ready[0]
        gaps.append(0.0 if i == 0 else start - end)
        end = start + audio[i]
    return ready, gaps, end


def worker(a):
    import numpy as np
    import onnxruntime as ort
    from kokoro_onnx import Kokoro
    t_imp2 = time.perf_counter()
    so = ort.SessionOptions()
    if a.threads:
        so.intra_op_num_threads = a.threads
    provs = ["CPUExecutionProvider"]
    if a.cfg == "gpu":
        provs = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    base_vram = vram_used() if a.cfg == "gpu" else None
    peak = [base_vram or 0]; stop = [False]

    def poll():
        while not stop[0]:
            v = vram_used()
            if v:
                peak[0] = max(peak[0], v)
            time.sleep(0.25)
    if a.cfg == "gpu":
        threading.Thread(target=poll, daemon=True).start()
    t_l0 = time.perf_counter()
    sess = ort.InferenceSession(MODEL, sess_options=so, providers=provs)
    k = Kokoro.from_session(sess, VOICES)
    t_l1 = time.perf_counter()
    print("READY", flush=True)
    out = {"cfg": a.cfg, "threads": a.threads, "ort": ort.__version__, "providers_active": sess.get_providers(),
           "import_s": t_imp2 - T0, "session_plus_kokoro_load_s": t_l1 - t_l0,
           "process_start_to_ready_s": t_l1 - T0}
    if a.loadonly:
        out["peak_rss_mb"] = peak_rss_mb(); print("RESULT=" + json.dumps(out)); return
    out["voices"] = {}
    for voice in a.voices.split(","):
        sents, lang = (EN, "en-us") if voice.startswith("a") else (ES, "es")

        def run():
            ss, aa = [], []
            for s in sents:
                t = time.perf_counter(); au, sr = k.create(s, voice=voice, speed=1.0, lang=lang); d = time.perf_counter() - t
                ss.append(d); aa.append(len(au) / sr)
            return ss, aa
        run()  # warm-up
        reps = [run() for _ in range(a.reps)]
        synth = [st.median(r[0][i] for r in reps) for i in range(len(sents))]
        audio = [st.median(r[1][i] for r in reps) for i in range(len(sents))]
        ready, gaps, end = timeline(synth, audio)
        words = sum(len(s.split()) for s in sents)
        per_rep = []
        for r in reps:
            rd, gp, _ = timeline(*r); per_rep.append({"ttfa": rd[0], "max_gap": max(gp), "total_gap": sum(gp)})
        v = {"words": words,
             "sentences": [{"words": len(s.split()), "synth_s": synth[i], "audio_s": audio[i], "rtf": synth[i] / audio[i],
                            "ready_at_s": ready[i], "gap_before_s": gaps[i]} for i, s in enumerate(sents)],
             "time_to_first_audio_s": synth[0], "total_synth_s": sum(synth), "total_audio_s": sum(audio),
             "overall_rtf": sum(synth) / sum(audio), "max_gap_s": max(gaps), "total_gap_s": sum(gaps),
             "playback_end_s": end, "per_rep": per_rep,
             "ttfa_all_reps_s": [r[0][0] for r in reps]}
        if a.stream:
            import asyncio
            txt = " ".join(sents)

            async def go():
                ts, t = [], time.perf_counter()
                async for ch, sr in k.create_stream(txt, voice=voice, speed=1.0, lang=lang):
                    ts.append((time.perf_counter() - t, len(ch) / sr))
                return ts
            asyncio.run(go())  # warm
            runs = [asyncio.run(go()) for _ in range(a.reps)]
            v["stream"] = {"chunks_per_run": len(runs[0]), "first_chunk_s_median": st.median(r[0][0] for r in runs),
                           "first_chunk_audio_s": runs[0][0][1], "total_s_median": st.median(r[-1][0] for r in runs),
                           "chunk_times_run0": runs[0]}
        out["voices"][voice] = v
    stop[0] = True
    out["peak_rss_mb"] = peak_rss_mb()
    if a.cfg == "gpu":
        out["vram_baseline_mb"] = base_vram; out["vram_peak_mb"] = peak[0]; out["vram_delta_mb"] = peak[0] - (base_vram or 0)
    print("RESULT=" + json.dumps(out))


def run_worker(py, extra, env=None):
    t = time.perf_counter()
    p = subprocess.Popen([py, "-u", os.path.abspath(__file__), "worker"] + extra, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, text=True, env=env)
    wall_ready = None; res = None
    for line in p.stdout:
        if line.startswith("READY") and wall_ready is None:
            wall_ready = time.perf_counter() - t
        if line.startswith("RESULT="):
            res = json.loads(line[7:])
    err = p.stderr.read(); p.wait()
    if res is None:
        return {"error": err[-3000:]}
    res["wall_spawn_to_ready_s"] = wall_ready
    return res


def orchestrate(a):
    cpu = os.path.join(HERE, ".venv", "Scripts", "python.exe")
    res = {"date": time.strftime("%Y-%m-%d %H:%M"), "machine": "i9-12900H, RTX 3060 Laptop, Win11"}
    try:
        res["cpu_load_before_pct"] = subprocess.check_output(["powershell", "-NoProfile", "-Command",
            "(Get-CimInstance Win32_Processor).LoadPercentage"], text=True).strip()
    except Exception as e:
        res["cpu_load_before_pct"] = str(e)
    res["sweep_em_alex"] = {}
    for th in [0, 4, 8, 14]:
        r = res["sweep_em_alex"][str(th)] = run_worker(cpu, ["--cfg", "cpu", "--threads", str(th), "--voices", "em_alex"])
        print(th, r.get("voices", {}).get("em_alex", {}).get("time_to_first_audio_s"), r.get("error"), flush=True)
    ok = {k: v for k, v in res["sweep_em_alex"].items() if "voices" in v}
    best = min(ok, key=lambda k: ok[k]["voices"]["em_alex"]["total_synth_s"])
    res["best_cpu_threads"] = int(best)
    res["cpu_best_all_voices"] = run_worker(cpu, ["--cfg", "cpu", "--threads", best, "--voices", "em_alex,ef_dora,af_heart", "--stream"])
    res["load_repeats_cpu_best"] = [run_worker(cpu, ["--cfg", "cpu", "--threads", best, "--loadonly"]) for _ in range(3)]
    json.dump(res, open(os.path.join(HERE, "bench.json"), "w"), indent=1, ensure_ascii=False)
    print("cpu done", flush=True)


def gpu(a):
    py = os.path.join(HERE, ".venv-gpu", "Scripts", "python.exe")
    path = json.load(open(os.path.join(HERE, "bench.json")))
    env = dict(os.environ)
    sp = os.path.join(HERE, ".venv-gpu", "Lib", "site-packages", "nvidia")
    dirs = sorted({r for r, _, fs in os.walk(sp) if any(f.lower().endswith(".dll") for f in fs)}) if os.path.isdir(sp) else []
    env["PATH"] = os.pathsep.join(dirs + [env["PATH"]])  # only for this child process
    path["gpu_all_voices"] = run_worker(py, ["--cfg", "gpu", "--voices", "em_alex,ef_dora,af_heart", "--stream"], env)
    path["load_repeats_gpu"] = [run_worker(py, ["--cfg", "gpu", "--loadonly"], env) for _ in range(3)]
    json.dump(path, open(os.path.join(HERE, "bench.json"), "w"), indent=1, ensure_ascii=False)
    print("gpu done", flush=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode"); ap.add_argument("--cfg", default="cpu"); ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--voices", default="em_alex"); ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--stream", action="store_true"); ap.add_argument("--loadonly", action="store_true")
    a = ap.parse_args()
    {"worker": worker, "all": orchestrate, "gpu": gpu}[a.mode](a)
