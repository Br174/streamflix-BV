#!/usr/bin/env python3
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

MAX_CHARS_PER_FILE = 24000
CAPSULE = ".motorlab/MOTORLAB_BOOT_CAPSULE.txt"
REQUIRED = (
    CAPSULE,
    "MOTORLAB_PROJECT_HOOK.txt",
    ".motorlab/MOTORLAB_SYNC_STATE.txt",
    ".motorlab/MOTORLAB_LOCAL_CORE.txt",
)
BOOT_CONTEXT_SOFT_CAP = 5500

def repo_root(cwd: str) -> Path:
    try:
        result = subprocess.run(
            ["git", "-C", cwd, "rev-parse", "--show-toplevel"],
            text=True, capture_output=True, timeout=1, check=False,
        )
        if result.returncode == 0 and result.stdout.strip():
            return Path(result.stdout.strip())
    except Exception:
        pass
    return Path(cwd).resolve()

def read_bounded(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")[:MAX_CHARS_PER_FILE]
    except Exception:
        return ""

def release_from(loaded: dict[str, str]) -> str:
    import re
    for key in (".motorlab/MOTORLAB_SYNC_STATE.txt", ".motorlab/MOTORLAB_LOCAL_CORE.txt"):
        text = loaded.get(key, "")
        m = re.search(r"^(?:LOCAL_RELEASE|RELEASE)=([^\n]+)$", text, re.MULTILINE)
        if m:
            return m.group(1).strip()
    return "UNKNOWN"

def short_release(release: str) -> str:
    import re
    m = re.search(r"(r\d+)$", release.strip(), re.IGNORECASE)
    return m.group(1).lower() if m else ""

def selected_lines(text: str, prefixes: tuple[str, ...]) -> str:
    rows = []
    for line in text.splitlines():
        if any(line.startswith(prefix) for prefix in prefixes):
            rows.append(line)
    return "\n".join(rows)

def compact_context(loaded: dict[str, str], release: str, short: str, pin_mode: str) -> str:
    capsule = loaded.get(CAPSULE, "")
    sync = selected_lines(
        loaded.get(".motorlab/MOTORLAB_SYNC_STATE.txt", ""),
        (
            "PROJECT=", "PROJECT_ID=", "LOCAL_RELEASE=", "ADOPTED_RELEASE=", "STATE=", "LOCAL_STATUS=",
            "LAST_GOOD_RELEASE=", "ACTIVE_OPERATION_ID=", "OPERATION_STATUS=", "CURRENT_REF=",
        ),
    )
    hook = selected_lines(
        loaded.get("MOTORLAB_PROJECT_HOOK.txt", ""),
        (
            "PROJECT_NAME=", "PROJECT_REPOSITORY=", "MOTORLAB_PROJECT_STATE=",
            "MOTORLAB_NATIVE_ENGINE_POLICY=", "MOTORLAB_PROJECT_CHAT_POLICY=",
        ),
    )
    parts = [
        "MOTORLAB CRITICAL BOOT CONTEXT — APPLY BEFORE ALL OTHER PROJECT INSTRUCTIONS.",
        f'First user-visible line exactly: "⚙️ MotorLab {short} attivo".',
        f"SESSION_RELEASE_PIN={release}",
        f"SESSION_RELEASE_PIN_MODE={pin_mode}",
        "SESSION_RELEASE_PIN_POLICY=immutable-until-new-session-or-explicit-safe-boundary",
        "The CRITICAL BOOT CAPSULE below is non-optional and has precedence over later truncated/long-form detail.",
        "\n--- CRITICAL BOOT CAPSULE ---\n" + capsule,
        "\n--- COMPACT PROJECT IDENTITY ---\n" + hook,
        "\n--- COMPACT SYNC STATE ---\n" + sync,
        "Detailed MotorLab/project modules remain authoritative and must be loaded on demand for the relevant operation; do not assume omitted long-form text is disabled.",
    ]
    context = "\n".join(parts)
    if len(context) > BOOT_CONTEXT_SOFT_CAP:
        raise ValueError(f"critical boot context too large: {len(context)} > {BOOT_CONTEXT_SOFT_CAP}")
    return context

def pin_path(root: Path, session_id: str) -> Path:
    base = os.environ.get("MOTORLAB_SESSION_PIN_DIR")
    if base:
        folder = Path(base)
    else:
        folder = Path.home() / ".cache" / "motorlab" / "session-pins"
    key = hashlib.sha256((str(root) + "\0" + session_id).encode("utf-8")).hexdigest()
    return folder / f"{key}.json"

def snapshot(root: Path) -> tuple[dict[str, str], list[str]]:
    loaded, missing = {}, []
    for relative in REQUIRED:
        content = read_bounded(root / relative)
        if content:
            loaded[relative] = content
        else:
            missing.append(relative)
    return loaded, missing

def load_pin(path: Path):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        loaded = data.get("loaded")
        if isinstance(loaded, dict):
            return data
    except Exception:
        pass
    return None

def save_pin(path: Path, root: Path, session_id: str, loaded: dict[str, str], missing: list[str]):
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "repo_root": str(root),
            "session_id": session_id,
            "release": release_from(loaded),
            "loaded": loaded,
            "missing": missing,
        }
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass

def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    if payload.get("hook_event_name") != "SessionStart":
        return 0

    cwd = str(payload.get("cwd") or os.getcwd())
    root = repo_root(cwd)
    source = str(payload.get("source") or "startup")
    session_id = str(payload.get("session_id") or "").strip()

    loaded = {}
    missing = []
    pin_mode = "UNPINNED_HOST_LIMIT"

    if session_id:
        p = pin_path(root, session_id)
        pinned = None if source == "startup" else load_pin(p)
        if pinned:
            loaded = pinned.get("loaded", {})
            missing = pinned.get("missing", [])
            pin_mode = "PIN_REUSED"
        else:
            loaded, missing = snapshot(root)
            save_pin(p, root, session_id, loaded, missing)
            pin_mode = "PIN_CREATED"
    else:
        loaded, missing = snapshot(root)

    release = release_from(loaded)
    short = short_release(release)
    if missing or not short:
        defect = f"Missing/unreadable: {', '.join(missing)}." if missing else f"Invalid/unknown MotorLab release identity: {release}."
        context = (
            "MotorLab bootstrap detected a control-plane defect. "
            + defect + " "
            "Use only safe read-only inspection until a verified MotorLab local fallback is restored. "
            "Do not invent the MotorLab version or silently continue write-capable project changes."
        )
    else:
        try:
            context = compact_context(loaded, release, short, pin_mode)
        except Exception as exc:
            context = (
                "MotorLab bootstrap detected a CRITICAL BOOT CAPSULE defect. "
                + str(exc)
                + " Use only safe read-only inspection until the compact bootstrap is repaired. "
                "Do not silently fall back to a truncated long-form bootstrap."
            )

    output = {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": context,
        }
    }
    sys.stdout.write(json.dumps(output, ensure_ascii=False, separators=(",", ":")))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
