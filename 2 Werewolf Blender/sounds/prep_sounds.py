"""Make the finished sound files from the downloads (inside Blender, which can read MP3/OGG/WAV):

    blender --background --factory-startup --python sounds/prep_sounds.py

For each sound in library.json: decode sounds/_source/<id>.*, trim the silent padding, take the excerpt ("start":
seconds, or "auto" = the loudest stretch of "length" seconds), optionally soften it (lowpass, for the embers), set its
loudness for its layer, give a one-shot its fade, bake a loop with a 2 s equal-power crossfade so it repeats without a
gap, and write sounds/music|sfx/<id>.wav. Loudness targets (RMS of the audible part, dBFS) put music and ambience well
under the voices; the voices are measured too and printed for reference.
"""
import json
import os
import sys
import tempfile
import wave
import zipfile

import aud
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = {"music": -30.0, "bed": -34.0, "oneshot": -21.0}  # dBFS RMS of the audible part ("target" overrides)
LOOP_XF = 2.0  # s: ambience loops only (music and the heartbeat are authored loops: no crossfade)
RATE = 48000  # every file at 48 kHz: one video frame (24 fps) = 2000 samples, so loops can end exactly on a frame
FRAME = RATE // 24


def decode(path):
    if path.endswith(".zip"):
        z = zipfile.ZipFile(path)
        name = next(n for n in z.namelist() if n.lower().endswith((".mp3", ".ogg", ".wav")))
        tmp = os.path.join(tempfile.gettempdir(), "ww_" + os.path.basename(name))
        with open(tmp, "wb") as f:
            f.write(z.read(name))
        path = tmp
    s = aud.Sound(path)
    rate = int(s.specs[0])
    x = np.asarray(s.data(), dtype=np.float32)
    if x.ndim == 1:
        x = x[:, None]
    return x, rate


def rms_db(x):
    """RMS of the audible part, gated relative to the file's own level (40 dB under its loud moments)."""
    v = np.sqrt(np.mean(x.astype(np.float64) ** 2, axis=1))
    ref = np.percentile(v, 99.5) if len(v) else 0
    loud = v[v > ref * 10 ** (-40 / 20)]
    return 20 * np.log10(np.sqrt(np.mean(loud ** 2)) + 1e-12) if len(loud) else -99.0


def trim(x, rate, db=-80.0):
    """Only the codec's digital silence at both ends (an authored loop keeps its length)."""
    env = np.abs(x).max(axis=1)
    on = np.where(env > 10 ** (db / 20))[0]
    return x[on[0]:on[-1] + 1] if len(on) else x


def resample(x, rate, n=None):
    """To RATE (or to exactly n samples: a loop stretched by a hair to end on a frame boundary). Band-limited (FFT):
    no aliasing, no high-frequency loss."""
    n = n or int(round(len(x) * RATE / rate))
    if n == len(x):
        return x.astype(np.float32)
    out = np.empty((n, x.shape[1]), np.float32)
    for c in range(x.shape[1]):
        f = np.fft.rfft(x[:, c].astype(np.float64))
        g = np.zeros(n // 2 + 1, complex)
        m = min(len(f), len(g))
        g[:m] = f[:m]
        out[:, c] = np.fft.irfft(g, n) * (n / len(x))
    return out


def highpass(x, rate, cutoff=400.0):
    out = np.empty_like(x)
    freqs = np.fft.rfftfreq(len(x), 1 / rate)
    for c in range(x.shape[1]):
        f = np.fft.rfft(x[:, c])
        f *= (freqs / cutoff) ** 2 / np.sqrt(1 + (freqs / cutoff) ** 4)  # a gentle 2nd-order cut below the cutoff
        out[:, c] = np.fft.irfft(f, len(x))
    return out


def expander(x, rate, below_db=-18.0, ratio=1.5, floor_db=-14.0):
    """Push down everything quieter than below_db (relative to the fire's typical loud level), by at most floor_db:
    the steady roar sinks a little, the crackles stand out, and a quiet bed remains under them."""
    w = max(1, int(0.01 * rate))
    env = np.sqrt(np.convolve((x.astype(np.float64) ** 2).mean(axis=1), np.ones(w) / w, mode="same")) + 1e-9
    ref = np.percentile(env, 90)
    rel = 20 * np.log10(env / ref)
    g_db = np.maximum(np.where(rel < below_db, (rel - below_db) * (ratio - 1), 0.0), floor_db)
    g = 10 ** (np.convolve(g_db, np.ones(w * 3) / (w * 3), mode="same") / 20)
    return (x * g[:, None]).astype(np.float32)


def loudest(x, rate, length):
    n = int(length * rate)
    if len(x) <= n:
        return 0
    e = np.cumsum(np.concatenate([[0.0], (x.astype(np.float64) ** 2).mean(axis=1)]))
    w = e[n:] - e[:-n]
    return int(np.argmax(w[::max(1, rate // 50)]) * max(1, rate // 50))


def lowpass(x, rate, cutoff=2200.0):
    out = np.empty_like(x)
    for c in range(x.shape[1]):
        f = np.fft.rfft(x[:, c])
        freqs = np.fft.rfftfreq(len(x), 1 / rate)
        f *= 1 / np.sqrt(1 + (freqs / cutoff) ** 4)  # a gentle 2nd-order roll-off
        out[:, c] = np.fft.irfft(f, len(x))
    return out


def limit(x, ceiling=0.89, knee=0.5):
    """Soft-limit transients above knee x ceiling (instead of turning the whole file down for one click)."""
    t = knee * ceiling
    a = np.abs(x)
    over = a > t
    y = x.copy()
    y[over] = np.sign(x[over]) * (t + (ceiling - t) * np.tanh((a[over] - t) / (ceiling - t)))
    return y


def onset(x, rate, st, back=2.0, db=-30.0):
    """Move a start back to where the sound begins (a howl from its first breath, not from its middle)."""
    env = np.abs(x).max(axis=1)
    peak = env[st:st + rate].max() if st < len(env) else 0
    step = rate // 50
    lo = max(0, st - int(back * rate))
    i = st
    while i - step > lo and env[i - step:i].max() > peak * 10 ** (db / 20):
        i -= step
    return i


def period(x, rate, lo=1.0, hi=4.0):
    """The beat period of a rhythmic loop (the heartbeat), from the envelope's autocorrelation."""
    env = np.abs(x).max(axis=1)
    hop = rate // 100
    e = env[: len(env) // hop * hop].reshape(-1, hop).max(axis=1)
    e = e - e.mean()
    ac = np.correlate(e, e, mode="full")[len(e) - 1:]
    a, b = int(lo * 100), min(int(hi * 100), len(ac) - 1)
    return (a + int(np.argmax(ac[a:b]))) * hop


def loopable(x, rate, xf=None):
    n = int((xf or LOOP_XF) * rate)
    if len(x) < 3 * n:
        return x
    t = np.linspace(0, np.pi / 2, n)[:, None]
    y = x[:-n].copy()
    y[:n] = x[:n] * np.sin(t) + x[-n:] * np.cos(t)  # the tail fades into the head: no gap, no click
    return y


def fades(x, rate, fade_in=0.01, fade_out=0.3):
    a, b = int(fade_in * rate), int(fade_out * rate)
    if a:
        x[:a] *= np.linspace(0, 1, a)[:, None]
    if b and b < len(x):
        x[-b:] *= np.cos(np.linspace(0, np.pi / 2, b))[:, None]
    return x


def write(path, x, rate):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    y = (np.clip(x, -1, 1) * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(x.shape[1])
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(y.tobytes())


def main():
    lib = json.load(open(os.path.join(HERE, "library.json"), encoding="utf-8"))
    for sid, s in lib.items():
        raw = os.path.join(HERE, s["raw"])
        if not os.path.exists(raw):
            print(f"[prep] {sid}: not downloaded")
            continue
        x, rate = decode(raw)
        x = resample(x, rate)
        rate = RATE
        if s.get("length"):  # a numeric start counts from the file's own start (before any trim)
            st = loudest(trim(x, rate), rate, s["length"]) + int(np.argmax(np.abs(x).max(axis=1) > 1e-4)) if s.get("start") == "auto"                 else int(float(s.get("start", 0)) * rate)
            if s.get("onset"):
                st = onset(x, rate, st)
            x = x[st:st + int(s["length"] * rate)]
            s["picked_start"] = round(st / rate, 2)
        x = trim(x, rate)
        if s.get("lowpass"):
            x = lowpass(x, rate, s.get("lowpass_hz", 2200.0))
        if s.get("embers"):  # a burned-out fire: only the sparse pops, no roar
            x = expander(highpass(x, rate), rate)
        gain = 10 ** ((s.get("target", TARGET[s["layer"]]) - rms_db(x)) / 20)
        ceiling = 10 ** (s.get("ceiling_db", -1.0) / 20)
        x = limit(x * gain, ceiling, s.get("knee", 0.5))  # transients are limited, never the whole file turned down
        if s.get("loop"):
            if s.get("periodic"):  # a rhythm: whole beats only, starting in the quiet between beats, so the seam keeps time
                p = period(x, rate)
                env = np.abs(x).max(axis=1)
                w = max(1, rate // 50)
                quiet = np.convolve(env[:2 * p], np.ones(w) / w, mode="same")[w:p + w]
                start = w + int(np.argmin(quiet))
                x = x[start:]
                x = x[: max(p, len(x) // p * p)]
                x = fades(x, rate, fade_in=0.008, fade_out=0.008)  # the seam sits in silence; 8 ms fades remove any click
                s["period_s"] = round(p / rate, 3)
            if not s.get("authored"):  # ambience (and non-loop music): the tail fades into the head
                x = loopable(x, rate, s.get("xfade"))
            if s.get("rotate"):  # start later in the (already seamless) loop: its one crossfade moves to a better moment
                x = np.roll(x, -int(s["rotate"] * rate), axis=0)
            x = resample(x, rate, max(FRAME, int(round(len(x) / FRAME)) * FRAME))  # ends exactly on a frame boundary
        else:
            x = fades(x, rate, fade_in=s.get("fade_in", 0.01), fade_out=s.get("fade_out", 0.3))
        x = limit(x, ceiling, 0.9)  # after looping and stretching: still under the ceiling (a crossfade can add up)
        write(os.path.join(HERE, s["file"]), x, rate)
        s["seconds"] = round(len(x) / rate, 2)
        print(f"[prep] {sid}: {s['seconds']} s, {rms_db(x):.1f} dBFS -> {s['file']}")
    json.dump(lib, open(os.path.join(HERE, "library.json"), "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    vdir = os.path.join(os.path.dirname(os.path.dirname(HERE)), "FullGameFolder")
    levels = []
    for root, _, files in os.walk(vdir):
        for f in files[:40]:
            if f.startswith("beat_") and f.endswith(".wav"):
                with wave.open(os.path.join(root, f), "rb") as w:
                    v = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32)[:, None] / 32768
                levels.append(rms_db(v))
    if levels:
        print(f"[prep] voices for reference: median {np.median(levels):.1f} dBFS over {len(levels)} takes")


main()
