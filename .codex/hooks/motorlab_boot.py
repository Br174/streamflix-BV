#!/usr/bin/env python3
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

MAX_CHARS_PER_FILE = 24000
REQUIRED = (
    "MOTORLAB_PROJECT_HOOK.txt",
    ".motorlab/MOTORLAB_SYNC_STATE.txt",
    ".motorlab/MOTORLAB_LOCAL_CORE.txt",
)

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
    if missing:
        context = (
            "MotorLab bootstrap detected a control-plane defect. "
            f"Missing/unreadable: {', '.join(missing)}. "
            "Use only safe read-only inspection until a verified MotorLab local fallback is restored. "
            "Do not invent MotorLab policy or silently continue write-capable project changes."
        )
    else:
        parts = [
            "MotorLab bootstrap is mandatory for this project session.",
            'First user-visible line: "⚙️ MotorLab attivo".',
            f"SESSION_RELEASE_PIN={release}",
            f"SESSION_RELEASE_PIN_MODE={pin_mode}",
            "SESSION_RELEASE_PIN_POLICY=immutable-until-new-session-or-explicit-safe-boundary",
            "Do not adopt a newer MotorLab release during this session, including resume/compact/clear.",
            "MotorLab coexists with and preserves the native project engine; it never replaces project/domain behavior.",
            "Apply the pinned verified local MotorLab contract below before substantive work. Preserve current operation/checkpoint/progress and single-writer safety.",
        ]
        for relative in REQUIRED:
            parts.append(f"\n--- {relative} ---\n{loaded[relative]}")
        context = "\n".join(parts)

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
