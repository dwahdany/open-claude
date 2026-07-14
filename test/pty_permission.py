# /// script
# requires-python = ">=3.10"
# dependencies = ["pexpect"]
# ///
"""Drive the opencode TUI to trigger a permission dialog, approve it, and confirm the tool runs."""
import os
import re
import sys
import time

import pexpect

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4097"
DIRECTORY = sys.argv[2] if len(sys.argv) > 2 else "/tmp/oc-test-proj"
PROMPT = "Create a file named ptytest.txt containing exactly zebra-8823 using the Write tool. Then stop."

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Za-z0-9]|\x1b[=>]|\x1b\][^\x07]*\x07")


def clean(buf: str) -> str:
    return "".join(ch for ch in ANSI.sub("", buf) if ch == "\n" or ch >= " ")


env = dict(os.environ, TERM="xterm-256color", COLUMNS="120", LINES="40")
child = pexpect.spawn("opencode", ["attach", URL, "--dir", DIRECTORY, "--log-level", "ERROR"], env=env, dimensions=(40, 120), encoding="utf-8", timeout=60)
cap: list[str] = []


def drain(seconds: float):
    end = time.time() + seconds
    while time.time() < end:
        try:
            cap.append(child.read_nonblocking(65536, timeout=0.4))
        except pexpect.TIMEOUT:
            pass
        except pexpect.EOF:
            break


drain(6)
child.send(PROMPT)
time.sleep(1.0)
child.send("\r")

# Wait for the permission dialog to appear.
drain(8)
dialog = clean("".join(cap))
saw_dialog = "Allow once" in dialog or "Allow always" in dialog or "Reject" in dialog
print("===== PERMISSION DIALOG PRESENT:", saw_dialog, "=====")
print(dialog[-1500:])

# Approve: Enter selects the focused option (Allow once).
child.send("\r")
drain(15)
final = clean("".join(cap))
print("\n===== AFTER APPROVE (tail) =====")
print(final[-1800:])

try:
    child.sendcontrol("c")
    time.sleep(0.2)
    child.sendcontrol("c")
    child.close(force=True)
except Exception:
    pass

print("\n===== VERDICT =====")
print("DIALOG_SHOWN:", saw_dialog)
