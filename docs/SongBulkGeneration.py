#!/usr/bin/env python3
"""SongBulkGeneration.py — one automated BGM fill/repair pipeline.

Combines the jobs of BULK_MUSIC_CHECKER, BatchSongFailureChecker, and the
bulk path in SunoV5Req into a single non-interactive script:

  1. Scan every BGM shelf for missing slots within the target (4 / 6 / 8).
  2. Flag tracks at/over 7:50 as bad; a bad track dooms its whole pair.
  3. For every incomplete pair inside the target, generate 2 songs and
     write them into the correct slots.
  4. Tracks numbered above the target are ignored (not deleted).

Settings (only these):
  --tracks   even target per shelf: 4, 6, or 8  (default 6)
  --workers  how many pair-jobs to run in parallel (default 3)
  --dry-run  plan only, no API calls / no deletes

Resilience:
  - Transient network errors (DNS/getaddrinfo, timeouts, 5xx) are retried
    with backoff instead of exiting the whole script.
  - Ctrl+C once: finish the current in-flight batch, then stop submitting
    new jobs and exit gracefully. Ctrl+C again: force quit.

Usage:
  python docs/SongBulkGeneration.py
  python docs/SongBulkGeneration.py --tracks 4 --workers 2
  python docs/SongBulkGeneration.py --dry-run --tracks 6
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Paths & API
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).resolve().parent
MYTHWEAVER_ROOT = SCRIPT_DIR.parent
BGM_ROOT = MYTHWEAVER_ROOT / "public" / "music" / "BGM"
SOUND_DESIGN = SCRIPT_DIR / "SOUND_DESIGN.md"

# Local-only. Do not commit a real key to source control.
API_KEY = "sk-"
PROMPT = """
[INSTRUMENTAL, NO LYRICS SHOULD BE SUNG]
[INSTRUMENTAL, NO LYRICS SHOULD BE SUNG]
[INSTRUMENTAL, NO LYRICS SHOULD BE SUNG]
[INSTRUMENTAL, NO LYRICS SHOULD BE SUNG]
[INSTRUMENTAL, NO LYRICS SHOULD BE SUNG]
[INSTRUMENTAL, NO LYRICS SHOULD BE SUNG]
"""
MODEL = "V5_5"
API_URL = "https://api.paxsenix.org/ai-music/suno-music"

# ---------------------------------------------------------------------------
# Fixed behaviour (not CLI knobs)
# ---------------------------------------------------------------------------

ALLOWED_TARGETS = (4, 6, 8)
DEFAULT_TARGET = 6
DEFAULT_WORKERS = 8
POLL_SECONDS = 60
BAD_DURATION_SECONDS = 7 * 60 + 50  # 7:50
# Reject downloads that are clearly not real tracks (error pages, stubs, etc.).
# Real BGM here is typically 2–5 MB; 64 KB is a safe floor.
MIN_AUDIO_BYTES = 64 * 1024
MEDIA_EXTENSIONS = {".mp3", ".wav", ".m4a", ".ogg"}
SLOT_FILENAME_RE = re.compile(r"^(?P<prefix>.+?)(?P<slot>\d+)$")

# Network resilience + graceful stop
MAX_NETWORK_RETRIES = 6
RETRY_BASE_SECONDS = 5
RETRYABLE_HTTP_CODES = {408, 425, 429, 500, 502, 503, 504}
_stop_requested = threading.Event()

# Core + extended themes from SOUND_DESIGN.md
THEMES = (
    "fantasy",
    "scifi",
    "horror",
    "noir",
    "modern",
    "western",
    "postapoc",
    "cyberpunk",
    "steampunk",
    "gothic",
    "urbanfantasy",
    "spaceopera",
    "pirate",
    "cozy",
    "eastasian",
    "superhero",
    "pulp",
)

MOODS = (
    "lobby",
    "weaving",
    "main",
    "calm",
    "tense",
    "adrenaline",
    "battle",
    "boss",
    "mystery",
    "dread",
    "triumph",
    "wonder",
    "somber",
    "outro",
    "outro-victory",
    "outro-defeat",
    "outro-bittersweet",
    "outro-escape",
    "outro-draw",
    "outro-cliffhanger",
)

FILL_PRIORITY = (
    "battle",
    "boss",
    "adrenaline",
    "tense",
    "mystery",
    "triumph",
    "somber",
    "dread",
    "wonder",
    "outro",
    "main",
    "lobby",
    "weaving",
    "calm",
    "outro-victory",
    "outro-defeat",
    "outro-bittersweet",
    "outro-escape",
    "outro-draw",
    "outro-cliffhanger",
)

# Fallback flavour tags when a themed shelf has no direct prompt in SOUND_DESIGN.
THEME_FLAVORS = {
    "fantasy": "orchestral folk palette, harp, strings, noble horns, wooden flute",
    "scifi": "analog synth palette, warm pads, slow arpeggios, sub bass, glassy bells",
    "horror": "haunted palette, detuned music box, hollow drones, bowed metal, breathy choir",
    "noir": "smoky jazz palette, muted trumpet, brushed drums, upright bass, lounge piano",
    "modern": "sleek hybrid palette, synth pads, processed percussion, taut strings, piano",
    "western": "frontier palette, reverb guitar, harmonica, lonesome whistle, fiddle",
    "postapoc": "wasteland palette, dusty guitar, junkyard percussion, kalimba, worn drones",
    "cyberpunk": "darksynth palette, synthwave, industrial techno, gritty neon-noir electronic",
    "steampunk": "clockwork percussion, Victorian orchestral, brass, dark cabaret, electro-swing",
    "gothic": "harpsichord, pipe organ, eerie chamber strings, dark choir, slow dirges",
    "urbanfantasy": "dark electronic, noir jazz, moody trip-hop, supernatural city night",
    "spaceopera": "grand heroic brass-heavy cinematic orchestral, sweeping galactic fanfare",
    "pirate": "accordion, sea shanties, acoustic fiddle, wooden percussion, naval fanfares",
    "cozy": "soft piano, acoustic fingerpicking, wooden flutes, light bells, lo-fi chillhop",
    "eastasian": "guzheng, koto, erhu, shakuhachi, taiko ensembles",
    "superhero": "Hollywood blockbuster brass, driving action strings, guitar/orchestral hybrid",
    "pulp": "brassy 1930s serial adventure fanfare, exotic tomb/jungle percussion",
}


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Shelf:
    path: Path
    relative_path: str  # e.g. "calm" or "calm/fantasy"
    style: str


@dataclass(frozen=True)
class Job:
    shelf: Shelf
    start_slot: int
    task_url: str


# ---------------------------------------------------------------------------
# Graceful stop (Ctrl+C once) + retry helpers
# ---------------------------------------------------------------------------

def stop_requested() -> bool:
    return _stop_requested.is_set()


def request_stop(_signum: int | None = None, _frame: Any = None) -> None:
    """First Ctrl+C: finish current job(s) then exit. Second: force quit."""
    if _stop_requested.is_set():
        print("\nForce exit on second Ctrl+C.", file=sys.stderr)
        raise SystemExit(130)
    _stop_requested.set()
    print(
        "\nStop requested — finishing current job(s), then exiting. "
        "Press Ctrl+C again to force quit.",
        file=sys.stderr,
    )


def install_stop_handler() -> None:
    try:
        signal.signal(signal.SIGINT, request_stop)
    except (ValueError, OSError):
        # signal only works on main thread; ignore if unavailable
        pass


def interruptible_sleep(seconds: float) -> bool:
    """Sleep up to `seconds`. Return True if stop was requested during the wait."""
    deadline = time.monotonic() + max(0.0, seconds)
    while True:
        if stop_requested():
            return True
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return stop_requested()
        time.sleep(min(0.5, remaining))


def is_retryable_network_error(error: BaseException) -> bool:
    """True for transient DNS / connection / timeout failures."""
    if isinstance(error, TimeoutError):
        return True
    if isinstance(error, urllib.error.URLError):
        return True
    if isinstance(error, OSError):
        # Windows: WinError 11001 (getaddrinfo failed), connection resets, etc.
        return True
    return False


# ---------------------------------------------------------------------------
# Filesystem helpers
# ---------------------------------------------------------------------------

def natural_key(path: Path) -> list[Any]:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", path.name)]


def media_files(shelf: Path) -> list[Path]:
    if not shelf.is_dir():
        return []
    return sorted(
        (
            item
            for item in shelf.iterdir()
            if item.is_file() and item.suffix.lower() in MEDIA_EXTENSIONS
        ),
        key=natural_key,
    )


def slot_index(path: Path) -> int | None:
    match = SLOT_FILENAME_RE.match(path.stem)
    if not match:
        return None
    return int(match.group("slot"))


def pair_starts_for(target: int) -> tuple[int, ...]:
    """Even target 4/6/8 → pair starts (1,3) / (1,3,5) / (1,3,5,7)."""
    return tuple(range(1, target, 2))


def pair_start_for(slot: int) -> int:
    """Odd start of the pair that contains `slot` (1&2→1, 3&4→3, ...)."""
    return slot if slot % 2 == 1 else slot - 1


def duration_seconds(media_file: Path) -> float:
    """Read duration via ffprobe (rejects damaged / overlong tracks).

    Tries a larger probe window first — some Suno MP3s have messy ID3/padding
    that trips the default probe even when players can still decode them.
    Falls back to a plain probe if the first attempt fails.
    """
    probe_attempts = (
        [
            "ffprobe",
            "-v",
            "error",
            "-probesize",
            "10M",
            "-analyzeduration",
            "30M",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nk=1:nw=1",
            str(media_file),
        ],
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nk=1:nw=1",
            str(media_file),
        ],
    )
    errors: list[str] = []
    for command in probe_attempts:
        result = subprocess.run(
            command,
            capture_output=True,
            check=False,
            text=True,
        )
        if result.returncode == 0:
            text = result.stdout.strip()
            if text:
                return float(text)
            errors.append("ffprobe returned empty duration")
            continue
        errors.append(result.stderr.strip() or "ffprobe could not read the file")
    raise RuntimeError(errors[-1] if errors else "ffprobe could not read the file")


def looks_like_audio_header(media_file: Path) -> bool:
    """Cheap magic-byte check before we trust a download as audio."""
    try:
        with media_file.open("rb") as handle:
            head = handle.read(12)
    except OSError:
        return False
    if len(head) < 3:
        return False
    if head.startswith(b"ID3"):
        return True
    # MPEG frame sync (mp3)
    if head[0] == 0xFF and (head[1] & 0xE0) == 0xE0:
        return True
    # RIFF/WAVE
    if head.startswith(b"RIFF") and b"WAVE" in head:
        return True
    # MP4/M4A ftyp box
    if len(head) >= 8 and head[4:8] == b"ftyp":
        return True
    # Ogg
    if head.startswith(b"OggS"):
        return True
    return False


def validate_audio_file(media_file: Path) -> float:
    """Return duration if the file is usable audio; raise RuntimeError otherwise.

    Used when culling shelves (invalid → delete + regen) and before promoting a
    download over an existing track (invalid download is discarded, good file kept).
    """
    if not media_file.is_file():
        raise RuntimeError("file missing")
    size = media_file.stat().st_size
    if size < MIN_AUDIO_BYTES:
        raise RuntimeError(f"too small ({size} bytes; need >= {MIN_AUDIO_BYTES})")
    if not looks_like_audio_header(media_file):
        raise RuntimeError("not a recognized audio header (HTML/JSON/truncated download?)")
    duration = duration_seconds(media_file)
    if duration <= 0:
        raise RuntimeError("zero/negative duration")
    return duration


def format_duration(seconds: float) -> str:
    minutes = int(seconds // 60)
    secs = int(seconds % 60)
    return f"{minutes}:{secs:02d}"


# ---------------------------------------------------------------------------
# Step 1+2: scan missing + cull long tracks (pair-aware)
# ---------------------------------------------------------------------------

def inspect_shelf(
    shelf: Path,
    target: int,
    *,
    dry_run: bool,
    skip_duration_check: bool,
) -> dict[int, Path]:
    """Return surviving in-target slot map after deleting bad pairs.

    - Only slots 1..target matter. Higher-numbered tracks are ignored.
    - A track >= 7:50 (or unreadable) marks its whole pair invalid.
    - Missing one half of a pair is handled later by the planner.
    """
    tracks = media_files(shelf)
    slot_to_track: dict[int, Path] = {}
    for track in tracks:
        slot = slot_index(track)
        if slot is None:
            continue
        # Ignore anything above the target (user may keep extras).
        if slot > target:
            continue
        slot_to_track[slot] = track

    invalid_slots: set[int] = set()

    if not skip_duration_check:
        for slot, track in list(slot_to_track.items()):
            try:
                # Truly invalid / unreadable / overlong → mark for delete + regen.
                duration = validate_audio_file(track)
                if duration >= BAD_DURATION_SECONDS:
                    print(
                        f"  BAD DURATION {format_duration(duration)} "
                        f"(>= {format_duration(BAD_DURATION_SECONDS)}): {track.name}"
                    )
                    invalid_slots.add(slot)
            except (RuntimeError, ValueError, FileNotFoundError) as error:
                print(f"  WARNING invalid track {track.name}: {error}")
                invalid_slots.add(slot)

    # A bad track dooms its entire pair — delete partner too.
    doomed_pairs: set[int] = set()
    for slot in list(invalid_slots):
        start = pair_start_for(slot)
        doomed_pairs.add(start)
        invalid_slots.add(start)
        invalid_slots.add(start + 1)

    for slot in sorted(invalid_slots):
        track = slot_to_track.get(slot)
        if not track or not track.exists():
            continue
        if dry_run:
            print(f"  WOULD DELETE {track.name}")
        else:
            print(f"  DELETE {track.name}")
            track.unlink()
            slot_to_track.pop(slot, None)

    if doomed_pairs and not dry_run:
        for start in sorted(doomed_pairs):
            slot_to_track.pop(start, None)
            slot_to_track.pop(start + 1, None)

    # Rebuild from disk after deletes so dry-run still reports pre-delete map.
    if not dry_run:
        slot_to_track = {}
        for track in media_files(shelf):
            slot = slot_index(track)
            if slot is not None and slot <= target:
                slot_to_track[slot] = track

    return slot_to_track


def plan_pairs(surviving: dict[int, Path], target: int) -> list[int]:
    """Return pair start slots that need generation (missing one or both)."""
    needed: list[int] = []
    for start in pair_starts_for(target):
        pair_slots = {start, start + 1}
        if not pair_slots.issubset(surviving):
            needed.append(start)
    return needed


# ---------------------------------------------------------------------------
# SOUND_DESIGN.md style parsing
# ---------------------------------------------------------------------------

def parse_styles(sound_design: Path) -> dict[str, str]:
    """Extract quoted BGM styles from SOUND_DESIGN.md.

    Accepts headings whose backtick path starts with ``BGM/`` or ``outro-``.
    """
    styles: dict[str, str] = {}
    current_target: str | None = None
    for line in sound_design.read_text(encoding="utf-8").splitlines():
        target = re.search(r"`([^`]+)`", line)
        if target and line.startswith("**"):
            path = target.group(1).rstrip("/")
            if path.startswith("BGM/"):
                current_target = path
            elif path.startswith("outro-"):
                current_target = f"BGM/{path}"
            continue
        if current_target and line.startswith("> "):
            styles[current_target] = line[2:].strip()
            current_target = None
    return styles


def style_for(relative_path: str, styles: dict[str, str]) -> str:
    direct = styles.get(f"BGM/{relative_path}")
    if direct:
        return direct

    mood, _, theme = relative_path.partition("/")
    root_style = styles.get(f"BGM/{mood}")
    if root_style and theme in THEME_FLAVORS:
        return f"{root_style}, {THEME_FLAVORS[theme]}"
    raise ValueError(f"No SOUND_DESIGN style found for BGM/{relative_path}")


def discover_shelves(styles: dict[str, str], create_missing: bool) -> list[Shelf]:
    """Return the full BGM catalog (neutral + every theme per mood)."""
    shelves: list[Shelf] = []
    for mood in MOODS:
        for theme in (None, *THEMES):
            relative_path = mood if theme is None else f"{mood}/{theme}"
            shelf_path = BGM_ROOT / relative_path
            if not shelf_path.exists():
                if create_missing:
                    print(f"CREATE {shelf_path.relative_to(MYTHWEAVER_ROOT)}")
                    shelf_path.mkdir(parents=True, exist_ok=True)
                else:
                    print(f"MISSING {shelf_path.relative_to(MYTHWEAVER_ROOT)}")
            if not shelf_path.exists():
                continue
            try:
                style = style_for(relative_path, styles)
            except ValueError as error:
                print(f"SKIP {relative_path}: {error}")
                continue
            shelves.append(Shelf(shelf_path, relative_path, style))

    priority = {mood: index for index, mood in enumerate(FILL_PRIORITY)}
    return sorted(
        shelves,
        key=lambda shelf: (
            priority.get(shelf.relative_path.split("/", 1)[0], 999),
            shelf.relative_path,
        ),
    )


# ---------------------------------------------------------------------------
# API: submit / poll / download
# ---------------------------------------------------------------------------

def api_request(url: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        ),
        "Accept": "application/json",
    }
    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url, data=data, headers=headers, method="POST" if data else "GET"
    )

    last_error: BaseException | None = None
    for attempt in range(1, MAX_NETWORK_RETRIES + 1):
        if stop_requested() and attempt > 1:
            raise RuntimeError("Stop requested during network retry")
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            last_error = error
            if error.code in RETRYABLE_HTTP_CODES and attempt < MAX_NETWORK_RETRIES:
                delay = RETRY_BASE_SECONDS * attempt
                print(
                    f"HTTP {error.code} (attempt {attempt}/{MAX_NETWORK_RETRIES}); "
                    f"retrying in {delay}s...",
                    file=sys.stderr,
                )
                if interruptible_sleep(delay):
                    raise RuntimeError("Stop requested during network retry") from error
                continue
            raise RuntimeError(f"HTTP {error.code}: {detail}") from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            last_error = error
            reason = getattr(error, "reason", error)
            if is_retryable_network_error(error) and attempt < MAX_NETWORK_RETRIES:
                delay = RETRY_BASE_SECONDS * attempt
                print(
                    f"Network error (attempt {attempt}/{MAX_NETWORK_RETRIES}): {reason}; "
                    f"retrying in {delay}s...",
                    file=sys.stderr,
                )
                if interruptible_sleep(delay):
                    raise RuntimeError("Stop requested during network retry") from error
                continue
            raise RuntimeError(f"Network error: {reason}") from error

    raise RuntimeError(f"Network error after {MAX_NETWORK_RETRIES} attempts: {last_error}")


def submit_job(shelf: Shelf, start_slot: int) -> Job:
    if stop_requested():
        raise RuntimeError("Stop requested — skipping new submit")
    title = f"Mythweaver {shelf.relative_path.replace('/', ' ')} {start_slot}-{start_slot + 1}"[:80]
    payload = {
        "customMode": True,
        "instrumental": True,
        "title": title,
        "style": shelf.style[:1000],
        "prompt": PROMPT,
        "model": MODEL,
        "negativeTags": "",
    }
    response = api_request(API_URL, payload)
    if not response.get("ok") or not response.get("task_url"):
        raise RuntimeError(response.get("message", f"Unexpected create response: {response}"))
    print(
        f"SUBMITTED {shelf.relative_path} slots {start_slot}-{start_slot + 1}: "
        f"{response['task_url']}"
    )
    return Job(shelf, start_slot, response["task_url"])


def download(url: str, destination: Path) -> None:
    """Download to a temp path and validate before the caller promotes it.

    Invalid payloads are deleted and retried. Existing final tracks are never
    overwritten by a bad download — only a validated .part is promoted.
    """
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            ),
        },
    )
    last_error: BaseException | None = None
    for attempt in range(1, MAX_NETWORK_RETRIES + 1):
        if stop_requested() and attempt > 1:
            raise RuntimeError("Stop requested during download retry")
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                content_type = (response.headers.get("Content-Type") or "").lower()
                # CDN sometimes returns HTML/JSON error bodies with HTTP 200.
                if content_type and not any(
                    token in content_type
                    for token in (
                        "audio/",
                        "video/",
                        "application/octet-stream",
                        "binary/",
                        "mpeg",
                    )
                ):
                    preview = response.read(256)
                    destination.unlink(missing_ok=True)
                    raise RuntimeError(
                        f"unexpected Content-Type {content_type!r}; "
                        f"body starts {preview[:80]!r}"
                    )
                with destination.open("wb") as output:
                    shutil.copyfileobj(response, output)
            try:
                validate_audio_file(destination)
            except (RuntimeError, ValueError) as validation_error:
                destination.unlink(missing_ok=True)
                last_error = validation_error
                if attempt < MAX_NETWORK_RETRIES:
                    delay = RETRY_BASE_SECONDS * attempt
                    print(
                        f"Downloaded invalid audio (attempt {attempt}/{MAX_NETWORK_RETRIES}): "
                        f"{validation_error}; retrying in {delay}s...",
                        file=sys.stderr,
                    )
                    if interruptible_sleep(delay):
                        raise RuntimeError(
                            "Stop requested during download retry"
                        ) from validation_error
                    continue
                raise RuntimeError(
                    f"Downloaded invalid audio after {MAX_NETWORK_RETRIES} attempts: "
                    f"{validation_error}"
                ) from validation_error
            return
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            last_error = error
            destination.unlink(missing_ok=True)
            if error.code in RETRYABLE_HTTP_CODES and attempt < MAX_NETWORK_RETRIES:
                delay = RETRY_BASE_SECONDS * attempt
                print(
                    f"Download HTTP {error.code} (attempt {attempt}/{MAX_NETWORK_RETRIES}); "
                    f"retrying in {delay}s...",
                    file=sys.stderr,
                )
                if interruptible_sleep(delay):
                    raise RuntimeError("Stop requested during download retry") from error
                continue
            raise RuntimeError(f"HTTP {error.code}: {detail}") from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            last_error = error
            reason = getattr(error, "reason", error)
            destination.unlink(missing_ok=True)
            if is_retryable_network_error(error) and attempt < MAX_NETWORK_RETRIES:
                delay = RETRY_BASE_SECONDS * attempt
                print(
                    f"Download network error (attempt {attempt}/{MAX_NETWORK_RETRIES}): {reason}; "
                    f"retrying in {delay}s...",
                    file=sys.stderr,
                )
                if interruptible_sleep(delay):
                    raise RuntimeError("Stop requested during download retry") from error
                continue
            raise RuntimeError(f"Network error: {reason}") from error
        except RuntimeError:
            # Content-type / validation failures already cleaned destination.
            raise

    raise RuntimeError(f"Download failed after {MAX_NETWORK_RETRIES} attempts: {last_error}")


def complete_job(job: Job, response: dict[str, Any]) -> None:
    records = response.get("records", [])
    if len(records) != 2 or any(not record.get("audio_url") for record in records):
        raise RuntimeError(f"Expected two audio records, got: {records}")

    slug = job.shelf.relative_path.replace("/", "-")
    temporary_files: list[tuple[Path, Path]] = []
    try:
        for offset, record in enumerate(records):
            destination = job.shelf.path / f"{slug}{job.start_slot + offset}.mp3"
            temporary = destination.with_suffix(".mp3.part")
            # download() validates the .part; existing destination stays put on failure.
            download(record["audio_url"], temporary)
            temporary_files.append((temporary, destination))
        # Promote only after BOTH halves of the pair validated.
        for temporary, destination in temporary_files:
            temporary.replace(destination)
        print(
            f"DOWNLOADED {job.shelf.relative_path} "
            f"slots {job.start_slot}-{job.start_slot + 1}"
        )
    finally:
        for temporary, _ in temporary_files:
            temporary.unlink(missing_ok=True)


def _poll_one(job: Job) -> tuple[Job, dict[str, Any] | None, str | None]:
    """Poll a single job; return (job, response, error_message)."""
    try:
        return job, api_request(job.task_url), None
    except (RuntimeError, OSError) as error:
        return job, None, str(error)


def poll_jobs(jobs: list[Job]) -> None:
    active = jobs[:]
    while active:
        if stop_requested():
            print(
                f"Stop requested — still finishing {len(active)} in-flight job(s)...",
                file=sys.stderr,
            )
        print(f"Polling {len(active)} job(s); next check in {POLL_SECONDS}s.")
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(active)) as executor:
            results = list(executor.map(_poll_one, active))

        next_active: list[Job] = []
        for job, response, error in results:
            if error is not None:
                # Transient failures already retried inside api_request; keep polling.
                print(
                    f"POLL ERROR {job.shelf.relative_path} "
                    f"slots {job.start_slot}-{job.start_slot + 1}: {error} "
                    f"(will retry next cycle)",
                    file=sys.stderr,
                )
                next_active.append(job)
                continue
            assert response is not None
            status = response.get("status")
            if response.get("ok") and status == "done":
                try:
                    complete_job(job, response)
                except (RuntimeError, OSError) as download_error:
                    print(
                        f"FAILED download {job.shelf.relative_path} "
                        f"slots {job.start_slot}-{job.start_slot + 1}: {download_error}",
                        file=sys.stderr,
                    )
            elif status in {"pending", "processing", "queued"}:
                next_active.append(job)
            else:
                print(
                    f"FAILED {job.shelf.relative_path} "
                    f"slots {job.start_slot}-{job.start_slot + 1}: {response}",
                    file=sys.stderr,
                )
        active = next_active
        if active:
            interruptible_sleep(POLL_SECONDS)


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def validate_configuration() -> None:
    placeholders = {
        "PASTE_YOUR_PAXSENIX_API_KEY_HERE",
        "PASTE_THE_REQUIRED_PROMPT_OR_LYRICS_HERE",
    }
    if API_KEY in placeholders or PROMPT.strip() in placeholders:
        raise RuntimeError("Set API_KEY and PROMPT at the top of this file before generating music.")
    if not SOUND_DESIGN.is_file():
        raise RuntimeError(f"SOUND_DESIGN.md not found at {SOUND_DESIGN}")
    if not BGM_ROOT.is_dir():
        raise RuntimeError(f"BGM root not found at {BGM_ROOT}")


def main() -> int:
    install_stop_handler()

    parser = argparse.ArgumentParser(
        description=(
            "Scan BGM shelves for missing tracks and overlong (>7:50) pairs, "
            "then regenerate incomplete pairs until each shelf hits the even target. "
            "Ctrl+C once: finish current job(s) then exit; twice: force quit."
        )
    )
    parser.add_argument(
        "--tracks",
        type=int,
        choices=ALLOWED_TARGETS,
        default=DEFAULT_TARGET,
        help=f"Even target tracks per shelf: {', '.join(map(str, ALLOWED_TARGETS))} (default {DEFAULT_TARGET}). "
        "Tracks numbered above this are ignored.",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=DEFAULT_WORKERS,
        help=f"Max pair-jobs submitted together (default {DEFAULT_WORKERS}).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Scan + plan only: no deletes, no API calls.",
    )
    parser.add_argument(
        "--skip-duration-check",
        action="store_true",
        help="Skip ffprobe / overlong cull (missing slots only).",
    )
    parser.add_argument(
        "--no-create",
        action="store_true",
        help="Do not create missing theme folders; only process existing shelves.",
    )
    args = parser.parse_args()

    target: int = args.tracks
    workers = max(args.workers, 1)

    if not args.dry_run:
        validate_configuration()
    else:
        if not SOUND_DESIGN.is_file() or not BGM_ROOT.is_dir():
            raise RuntimeError(f"Mythweaver music files not found under {MYTHWEAVER_ROOT}")

    print("=" * 72)
    print("SongBulkGeneration - scan missing -> cull >7:50 pairs -> fill pairs")
    print("=" * 72)
    print(f"BGM root : {BGM_ROOT}")
    print(f"Target   : {target} tracks/shelf (pairs of 2; ignore slots > {target})")
    print(f"Workers  : {workers}")
    print(f"Duration : {'SKIPPED' if args.skip_duration_check else f'cull >= {format_duration(BAD_DURATION_SECONDS)}'}")
    print(f"Mode     : {'DRY RUN' if args.dry_run else 'LIVE'}")
    print("-" * 72)

    styles = parse_styles(SOUND_DESIGN)
    print(f"Loaded {len(styles)} style prompt(s) from SOUND_DESIGN.md")

    shelves = discover_shelves(styles, create_missing=not args.dry_run and not args.no_create)
    print(f"Scanning {len(shelves)} shelf(s)...")
    print("-" * 72)

    planned: list[tuple[Shelf, int]] = []
    keep_count = 0
    need_count = 0

    for shelf in shelves:
        print(f"SHELF {shelf.relative_path}")
        surviving = inspect_shelf(
            shelf.path,
            target,
            dry_run=args.dry_run,
            skip_duration_check=args.skip_duration_check,
        )
        pairs = plan_pairs(surviving, target)
        good = len(surviving)
        if not pairs:
            print(f"  KEEP {good}/{target} valid track(s)")
            keep_count += 1
            continue
        need_count += 1
        missing_slots = [s for s in range(1, target + 1) if s not in surviving]
        print(
            f"  NEED {good}/{target} valid; missing/bad slots {missing_slots}; "
            f"regen pairs {[f'{p}-{p+1}' for p in pairs]}"
        )
        for start in pairs:
            planned.append((shelf, start))

    print("-" * 72)
    print(
        f"Summary: {keep_count} shelf(s) complete, {need_count} shelf(s) need work, "
        f"{len(planned)} pair job(s) planned"
    )

    if not planned:
        print(f"All scanned shelves already have {target} valid tracks.")
        return 0

    for shelf, slot in planned:
        print(f"PLAN {shelf.relative_path} slots {slot}-{slot + 1}")

    if args.dry_run:
        print("Dry run complete - no API calls made.")
        return 0

    print("-" * 72)
    print(f"Submitting {len(planned)} pair job(s) with {workers} worker(s)...")
    print("Tip: Ctrl+C once to stop after the current batch finishes.")

    stopped_early = False
    for start in range(0, len(planned), workers):
        if stop_requested():
            remaining = len(planned) - start
            print(
                f"\nStop requested — not starting remaining {remaining} pair job(s).",
                file=sys.stderr,
            )
            stopped_early = True
            break

        group = planned[start : start + workers]
        print(f"\n--- Batch {start // workers + 1}: {len(group)} job(s) ---")
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(group)) as executor:
            futures = {
                executor.submit(submit_job, shelf, slot): (shelf, slot)
                for shelf, slot in group
            }
            jobs: list[Job] = []
            for future in concurrent.futures.as_completed(futures):
                shelf, slot = futures[future]
                try:
                    jobs.append(future.result())
                except (RuntimeError, OSError) as error:
                    print(
                        f"SUBMIT FAILED {shelf.relative_path} slots {slot}-{slot + 1}: {error}",
                        file=sys.stderr,
                    )
        if jobs:
            poll_jobs(jobs)

    print("=" * 72)
    if stopped_early or stop_requested():
        print("Stopped gracefully.")
        return 0
    print("Done.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        # Fallback if signal handler did not catch it (e.g. during import).
        print("\nInterrupted.", file=sys.stderr)
        raise SystemExit(130)
    except (RuntimeError, OSError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
