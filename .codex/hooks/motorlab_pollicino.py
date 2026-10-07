#!/usr/bin/env python3
import hashlib
import hmac
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_BASE = "https://motorlab-state-bridge.brunoverlezza.workers.dev/continuity/v1"
ACTIVE_EVENTS = {"SessionStart", "UserPromptSubmit", "PostToolUse"}
TERMINAL_EVENTS = {
    "Stop": "HANDOFF_COMPLETE",
    "Interrupt": "CANCELLED_BY_USER",
    "SessionEnd": "HANDOFF_COMPLETE",
}
SHELL_NAMES = {"sh", "bash", "zsh", "dash", "fish", "cmd.exe", "powershell.exe", "pwsh.exe"}


def _repo_root(cwd: str) -> Path:
    try:
        out = subprocess.check_output(
            ["git", "-C", cwd, "rev-parse", "--show-toplevel"],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=2,
        ).strip()
        if out:
            return Path(out)
    except Exception:
        pass
    return Path(cwd).resolve()


def _project_id(cwd: str) -> str:
    override = os.environ.get("MOTORLAB_PROJECT_ID", "").strip()
    if override:
        return override
    try:
        remote = subprocess.check_output(
            ["git", "-C", cwd, "remote", "get-url", "origin"],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=2,
        ).strip()
        tail = remote.rstrip("/").split("/")[-1]
        if ":" in tail:
            tail = tail.split(":")[-1]
        if tail.endswith(".git"):
            tail = tail[:-4]
        if tail:
            return tail
    except Exception:
        pass
    return _repo_root(cwd).name


def _safe_id(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9._:/-]", "_", value or "")
    return value[:128]


def _local_proof_head(cwd: str) -> str:
    root = _repo_root(cwd)
    candidates = [
        root / ".motorlab" / "MOTORLAB_SYNC_STATE.txt",
        root / "MOTORLAB_PROJECT_HOOK.txt",
    ]
    pattern = re.compile(r"^(?:POLLICINO_PROOF_HEAD|MOTORLAB_POLLICINO_PROOF_HEAD)=([0-9a-fA-F]{7,64})\s*$")
    for path in candidates:
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                match = pattern.match(line.strip())
                if match:
                    return match.group(1).lower()
        except Exception:
            continue
    return ""


def _state_path(session_id: str) -> Path:
    base = Path(os.environ.get("MOTORLAB_HOOK_STATE_DIR") or (Path(tempfile.gettempdir()) / "motorlab-pollicino"))
    base.mkdir(parents=True, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", session_id or "unknown")
    return base / f"{safe}.json"


def _load_state(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_state(path: Path, data: dict) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def _git_snapshot(cwd: str) -> tuple[str, str]:
    head = ""
    status = ""
    try:
        head = subprocess.check_output(
            ["git", "-C", cwd, "rev-parse", "HEAD"],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=2,
        ).strip()
    except Exception:
        pass
    try:
        raw = subprocess.check_output(
            ["git", "-C", cwd, "status", "--porcelain=v1"],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=2,
        )
        status = hashlib.sha256(raw.encode("utf-8", errors="replace")).hexdigest()
    except Exception:
        pass
    return head, status


def _hash_json(value) -> str:
    try:
        raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except Exception:
        raw = repr(value)
    return hashlib.sha256(raw.encode("utf-8", errors="replace")).hexdigest()


def _transcript_stamp(path_value) -> str:
    if not path_value:
        return ""
    try:
        st = Path(str(path_value)).stat()
        return f"{st.st_size}:{st.st_mtime_ns}"
    except Exception:
        return ""


def _material_fingerprint(payload: dict, cwd: str) -> str:
    explicit = os.environ.get("MOTORLAB_PROGRESS_FINGERPRINT", "").strip()
    if explicit:
        return hashlib.sha256(explicit.encode("utf-8")).hexdigest()
    head, status_hash = _git_snapshot(cwd)
    event = str(payload.get("hook_event_name") or "")
    tool_name = str(payload.get("tool_name") or "")
    turn_id = str(payload.get("turn_id") or "")
    tool_hash = _hash_json(payload.get("tool_input")) if event == "PostToolUse" else ""
    transcript = _transcript_stamp(payload.get("transcript_path"))
    raw = "|".join((head, status_hash, event, turn_id, tool_name, tool_hash, transcript))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _host_pid() -> int:
    pid = os.getppid()
    if os.name != "posix":
        return pid
    for _ in range(3):
        try:
            name = subprocess.check_output(
                ["ps", "-o", "comm=", "-p", str(pid)],
                text=True,
                stderr=subprocess.DEVNULL,
                timeout=1,
            ).strip().lower()
            if name not in SHELL_NAMES:
                break
            parent = subprocess.check_output(
                ["ps", "-o", "ppid=", "-p", str(pid)],
                text=True,
                stderr=subprocess.DEVNULL,
                timeout=1,
            ).strip()
            pid = int(parent)
        except Exception:
            break
    return pid


def _pid_alive(pid: int) -> bool:
    if not pid or pid <= 1:
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except Exception:
        return False


def _clamp_int(value, default: int, low: int, high: int) -> int:
    try:
        return max(low, min(high, int(value)))
    except Exception:
        return default


def _secret() -> str:
    return (
        os.environ.get("MOTORLAB_POLLICINO_SECRET", "").strip()
        or os.environ.get("MOTORLAB_RELAY_SECRET", "").strip()
    )


def _endpoint(path: str) -> str:
    base = os.environ.get("MOTORLAB_POLLICINO_ENDPOINT", DEFAULT_BASE).strip().rstrip("/")
    return f"{base}/{path.lstrip('/')}"


def _json_request(method: str, url: str, body: bytes = b"", headers: dict | None = None) -> dict | None:
    merged = {
        "accept": "application/json",
        "content-type": "application/json",
        "user-agent": "MotorLab-Pollicino-Codex/1.1",
    }
    if headers:
        merged.update(headers)
    req = urllib.request.Request(url, data=body if method != "GET" else None, method=method, headers=merged)
    try:
        with urllib.request.urlopen(req, timeout=2) as response:
            payload = json.loads(response.read().decode("utf-8"))
            return payload if isinstance(payload, dict) else {}
    except Exception:
        return None


def _signed_request(method: str, url: str, body: bytes = b"") -> dict | None:
    secret = _secret()
    if not secret:
        return None
    timestamp = str(int(time.time()))
    parsed = urllib.parse.urlsplit(url)
    path_query = parsed.path + (f"?{parsed.query}" if parsed.query else "")
    canonical = f"{timestamp}.{method}.{path_query}.{body.decode('utf-8')}"
    signature = hmac.new(secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()
    return _json_request(method, url, body, {
        "x-motorlab-timestamp": timestamp,
        "x-motorlab-signature": signature,
    })


def _bearer_request(method: str, url: str, token: str, body: bytes = b"") -> dict | None:
    if not token:
        return None
    return _json_request(method, url, body, {"authorization": f"Bearer {token}"})


def _discover_operation(project_id: str, source_head: str = "") -> dict | None:
    query = {"project_id": project_id}
    if source_head:
        query["source_head"] = source_head
    url = _endpoint("context") + "?" + urllib.parse.urlencode(query)
    if _secret():
        return _signed_request("GET", url, b"")
    return _json_request("GET", url, b"")


def _enroll(project_id: str, session_id: str, source_head: str) -> dict | None:
    if not source_head:
        return None
    payload = {
        "project_id": project_id,
        "session_id": session_id,
        "source_head": source_head,
        "executor_type": "codex-hook-sidecar",
    }
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return _json_request("POST", _endpoint("enroll"), body)


def _runtime_fingerprint(state: dict) -> str:
    cwd = str(state.get("cwd") or os.getcwd())
    head, status_hash = _git_snapshot(cwd)
    transcript = _transcript_stamp(state.get("transcript_path"))
    raw = "|".join((
        str(state.get("base_fingerprint") or ""),
        head,
        status_hash,
        transcript,
    ))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _progress_percent() -> int | None:
    raw = os.environ.get("MOTORLAB_PROGRESS_PERCENT", "").strip()
    if not raw:
        return None
    try:
        value = int(raw)
        return max(0, min(100, value))
    except Exception:
        return None


def _pulse_payload(state: dict) -> dict:
    interval = _clamp_int(os.environ.get("MOTORLAB_POLLICINO_PULSE_SECONDS"), 15, 5, 300)
    lease_ms = _clamp_int(os.environ.get("MOTORLAB_POLLICINO_LEASE_MS"), interval * 3000, interval * 2000, 15 * 60 * 1000)
    stall_pulses = _clamp_int(os.environ.get("MOTORLAB_POLLICINO_STALL_PULSES"), 4, 2, 20)
    payload = {
        "session_id": state["session_id"],
        "operation_id": state["operation_id"],
        "project_id": state["project_id"],
        "canonical_chat_ref": state.get("canonical_chat_ref"),
        "executor_type": "codex-hook-sidecar",
        "executor_id": str(state.get("host_pid") or ""),
        "liveness_mode": "PUSH_HEARTBEAT",
        "progress_fingerprint": _runtime_fingerprint(state),
        "progress_expected": bool(state.get("turn_active", True)),
        "external_wait": os.environ.get("MOTORLAB_EXTERNAL_WAIT", "").strip().lower() in {"1", "true", "yes"},
        "lease_ms": lease_ms,
        "stall_after_unchanged_pulses": stall_pulses,
        "phase": os.environ.get("MOTORLAB_PHASE") or state.get("phase"),
        "last_completed_action": state.get("last_completed_action"),
        "current_action": state.get("current_action"),
        "next_action": os.environ.get("MOTORLAB_NEXT_ACTION") or state.get("next_action"),
        "verified_progress": _progress_percent(),
        "source_ref": state.get("source_ref"),
        "source_head": state.get("source_head"),
        "provider_job_id": os.environ.get("MOTORLAB_PROVIDER_JOB_ID") or None,
        "provider_job_status": os.environ.get("MOTORLAB_PROVIDER_JOB_STATUS") or None,
        "sent_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    return {k: v for k, v in payload.items() if v is not None}


def _send_pulse(state: dict) -> dict | None:
    body = json.dumps(_pulse_payload(state), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if _secret():
        return _signed_request("POST", _endpoint("pulse"), body)
    return _bearer_request("POST", _endpoint("pulse"), str(state.get("session_token") or ""), body)


def _send_seal(state: dict, terminal_state: str) -> dict | None:
    payload = {
        "project_id": state["project_id"],
        "operation_id": state["operation_id"],
        "session_id": state["session_id"],
        "terminal_state": terminal_state,
    }
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    if _secret():
        return _signed_request("POST", _endpoint("seal"), body)
    return _bearer_request("POST", _endpoint("seal"), str(state.get("session_token") or ""), body)


def _daemon_interval() -> int:
    return _clamp_int(os.environ.get("MOTORLAB_POLLICINO_PULSE_SECONDS"), 15, 5, 300)


def _daemon(path: Path, host_pid: int) -> int:
    while True:
        state = _load_state(path)
        if not state or not state.get("turn_active", False):
            return 0
        if not _pid_alive(host_pid):
            # Intentional: no terminal seal. The external Alarm will classify liveness loss.
            return 0
        _send_pulse(state)
        time.sleep(_daemon_interval())


def _daemon_alive(pid_value) -> bool:
    try:
        return _pid_alive(int(pid_value))
    except Exception:
        return False


def _ensure_daemon(path: Path, state: dict) -> None:
    if _daemon_alive(state.get("daemon_pid")):
        return
    proc = subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "--daemon", str(path), str(state["host_pid"])],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        close_fds=True,
        env=os.environ.copy(),
    )
    state["daemon_pid"] = proc.pid
    _save_state(path, state)


def _hook_main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0

    event = str(payload.get("hook_event_name") or "")
    if event not in ACTIVE_EVENTS and event not in TERMINAL_EVENTS:
        return 0

    session_id = _safe_id(str(payload.get("session_id") or ""))
    if not session_id:
        return 0

    cwd = str(payload.get("cwd") or os.getcwd())
    project_id = _safe_id(_project_id(cwd))
    if not project_id:
        return 0

    path = _state_path(session_id)
    state = _load_state(path)
    head, _ = _git_snapshot(cwd)
    runtime_head = os.environ.get("MOTORLAB_SOURCE_HEAD", "").strip() or head
    proof_head = _local_proof_head(cwd) or runtime_head
    operation_id = _safe_id(os.environ.get("MOTORLAB_OPERATION_ID", "").strip() or str(state.get("operation_id") or ""))
    context = None

    if _secret() and not operation_id:
        discovered = _discover_operation(project_id, proof_head)
        context = discovered.get("context") if isinstance(discovered, dict) else None
        operation_id = _safe_id(str((context or {}).get("operation_id") or ""))

    if not operation_id and not state.get("session_token"):
        enrolled = _enroll(project_id, session_id, proof_head)
        if isinstance(enrolled, dict):
            operation_id = _safe_id(str(enrolled.get("operation_id") or ""))
            token = str(enrolled.get("session_token") or "")
            if operation_id and token:
                state["session_token"] = token
                state["token_expires_at"] = enrolled.get("token_expires_at")
                context = enrolled.get("context") if isinstance(enrolled.get("context"), dict) else None

    if not operation_id:
        return 0

    state.update({
        "session_id": session_id,
        "operation_id": operation_id,
        "project_id": project_id,
        "cwd": cwd,
        "host_pid": _host_pid(),
        "transcript_path": payload.get("transcript_path"),
        "canonical_chat_ref": os.environ.get("MOTORLAB_CANONICAL_CHAT_REF") or None,
        "source_ref": os.environ.get("MOTORLAB_SOURCE_REF") or (context or {}).get("source_ref") or None,
        "source_head": runtime_head or (context or {}).get("source_head") or None,
        "proof_head": proof_head or None,
        "phase": os.environ.get("MOTORLAB_PHASE") or (context or {}).get("phase") or None,
        "next_action": os.environ.get("MOTORLAB_NEXT_ACTION") or None,
        "updated_at": time.time(),
    })

    if event in ACTIVE_EVENTS:
        state["turn_active"] = True
        state["base_fingerprint"] = _material_fingerprint(payload, cwd)
        state["current_action"] = str(payload.get("tool_name") or event)
        if event == "PostToolUse":
            state["last_completed_action"] = str(payload.get("tool_name") or "tool")
        _save_state(path, state)
        first_pulse = _send_pulse(state)
        state["initial_pulse_ok"] = isinstance(first_pulse, dict)
        state["initial_pulse_at"] = time.time() if state["initial_pulse_ok"] else None
        _save_state(path, state)
        _ensure_daemon(path, state)
        return 0

    terminal = TERMINAL_EVENTS[event]
    state["turn_active"] = False
    state["current_action"] = event
    _save_state(path, state)
    _send_seal(state, terminal)
    return 0


def main() -> int:
    if len(sys.argv) >= 4 and sys.argv[1] == "--daemon":
        try:
            return _daemon(Path(sys.argv[2]), int(sys.argv[3]))
        except Exception:
            return 0
    return _hook_main()


if __name__ == "__main__":
    raise SystemExit(main())
