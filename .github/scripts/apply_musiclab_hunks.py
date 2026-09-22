#!/usr/bin/env python3
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
