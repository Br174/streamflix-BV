#!/usr/bin/env python3
import os
import subprocess
import sys
from pathlib import Path

if len(sys.argv) != 3:
    raise SystemExit("usage: apply_musiclab_hunks.py TARGET PATCH")

target = Path(sys.argv[1])
patch_path = Path(sys.argv[2])
text = target.read_text(encoding="utf-8")
had_newline = text.endswith("\n")
lines = text.splitlines()
patch_lines = patch_path.read_text(encoding="utf-8").splitlines()

hunks = []
current = None
for line in patch_lines:
    if line.startswith("@@"):
        if current is not None:
            hunks.append(current)
        current = []
    elif current is not None and line[:1] in {" ", "+", "-"}:
        current.append(line)
if current is not None:
    hunks.append(current)


def find_subseq(haystack, needle):
    if not needle:
        return None
    limit = len(haystack) - len(needle) + 1
    for i in range(max(0, limit)):
        if haystack[i : i + len(needle)] == needle:
            return i
    return None


for number, hunk in enumerate(hunks, 1):
    old = [line[1:] for line in hunk if line[:1] in {" ", "-"}]
    new = [line[1:] for line in hunk if line[:1] in {" ", "+"}]
    pos = find_subseq(lines, old)
    if pos is None:
        raise SystemExit(f"Could not locate PlayerMenu hunk {number}")
    lines[pos : pos + len(old)] = new

result = "\n".join(lines) + ("\n" if had_newline else "")
target.write_text(result, encoding="utf-8")
print(f"Applied {len(hunks)} PlayerMenu hunks")

# Compose's current layout API exposes weight through RowScope/ColumnScope.
# The explicit top-level import resolves to an internal parent-data property and
# breaks compilation, so remove only that import from the reconstructed LAB.
cover_dialog = Path("/tmp/MusicLab/app/src/main/kotlin/com/metrolist/music/ui/component/CoverSearchDialog.kt")
cover_text = cover_dialog.read_text(encoding="utf-8")
bad_import = "import androidx.compose.foundation.layout.weight\n"
if bad_import in cover_text:
    cover_dialog.write_text(cover_text.replace(bad_import, "", 1), encoding="utf-8")
    print("Removed incompatible Compose weight import from CoverSearchDialog.kt")
else:
    print("Compose weight import already absent from CoverSearchDialog.kt")

# A clean GitHub-hosted runner may not have Android's conventional debug keystore.
# The app's FossDebug signing config expects ~/.android/debug.keystore, so create
# the standard disposable Android debug key when it is missing.
android_dir = Path.home() / ".android"
keystore = android_dir / "debug.keystore"
if not keystore.exists():
    android_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "keytool",
            "-genkeypair",
            "-keystore",
            str(keystore),
            "-storepass",
            "android",
            "-alias",
            "androiddebugkey",
            "-keypass",
            "android",
            "-keyalg",
            "RSA",
            "-keysize",
            "2048",
            "-validity",
            "10000",
            "-dname",
            "CN=Android Debug,O=Android,C=US",
            "-noprompt",
        ],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    os.chmod(keystore, 0o600)
    print(f"Created Android debug keystore at {keystore}")
else:
    print(f"Android debug keystore already present at {keystore}")
