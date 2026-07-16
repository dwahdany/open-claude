# /// script
# requires-python = ">=3.10"
# dependencies = ["pexpect"]
# ///
"""Verify global launch defaults (model + mode) end-to-end against the real TUI.

Usage: pty_defaults.py <url> <directory> <settings-json-path>

The server at <url> must have been booted with XDG_DATA_HOME pointing at the data root
that contains <settings-json-path>, seeded with:
    {"defaults": {"model": "anthropic/claude-fable-5", "agent": "auto"}}

Token-free round trip:
  1. Boot: the home screen must show Claude Fable 5 (GET /config model steers the TUI's
     fallback chain) and agent "auto" (GET /agent order → agents().at(0)).
  2. Tab cycles to the next agent in the SERVED order ([auto, build, plan] → build);
     typing /model submits an engine-less command turn that carries the TUI's current
     model+agent, so settings.json must flip defaults.agent to "build" and keep the model.
"""
import json
import os
import re
import sys
import time

import pexpect

URL = sys.argv[1]
DIRECTORY = sys.argv[2]
SETTINGS = sys.argv[3]

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Za-z0-9]|\x1b[=>]|\x1b\][^\x07]*\x07")


def clean(buf: str) -> str:
    buf = ANSI.sub("", buf)
    return "".join(ch for ch in buf if ch == "\n" or ch >= " ")


env = dict(os.environ, TERM="xterm-256color", COLUMNS="120", LINES="40")
child = pexpect.spawn(
    "opencode",
    ["attach", URL, "--dir", DIRECTORY, "--log-level", "ERROR"],
    env=env,
    dimensions=(40, 120),
    encoding="utf-8",
    timeout=60,
)
capture: list[str] = []


def drain(seconds: float):
    end = time.time() + seconds
    while time.time() < end:
        try:
            capture.append(child.read_nonblocking(65536, timeout=0.4))
        except pexpect.TIMEOUT:
            pass
        except pexpect.EOF:
            capture.append("\n<<EOF>>\n")
            break


# 1. Boot to the home screen; the footer must already show the seeded pair.
drain(6)
boot = clean("".join(capture))
print("===== AFTER BOOT (tail) =====")
print(boot[-2000:])
boot_low = boot.lower()
model_shown = "fable" in boot_low
agent_shown = "auto" in boot_low

# 2. Tab → next agent in served order (auto → build), then submit /model.
child.send("\t")
time.sleep(0.8)
child.send("/model")
time.sleep(1.0)
child.send("\r")  # accept the autocomplete row → inserts "/model "
time.sleep(0.8)
child.send("\r")  # submit
drain(6)
after = clean("".join(capture))
print("===== AFTER /model (tail) =====")
print(after[-2000:])
view_shown = "current model: claude fable 5" in after.lower()

# 3. The command carried (fable-5, build); poll settings.json for the async note.
noted_agent = noted_model = None
deadline = time.time() + 8
while time.time() < deadline:
    try:
        with open(SETTINGS) as f:
            defaults = json.load(f).get("defaults", {})
        noted_agent, noted_model = defaults.get("agent"), defaults.get("model")
        if noted_agent == "build":
            break
    except Exception:
        pass
    time.sleep(0.5)

try:
    child.sendcontrol("c")
    time.sleep(0.3)
    child.sendcontrol("c")
    child.close(force=True)
except Exception:
    pass

print("\n===== VERDICT =====")
print("BOOT_MODEL_FABLE:", model_shown)
print("BOOT_AGENT_AUTO:", agent_shown)
print("MODEL_VIEW_SHOWN:", view_shown)
print("NOTED_AGENT_BUILD:", noted_agent == "build")
print("NOTED_MODEL_KEPT:", noted_model == "anthropic/claude-fable-5")
ok = model_shown and agent_shown and view_shown and noted_agent == "build" and noted_model == "anthropic/claude-fable-5"
print("PTY_DEFAULTS_OK:", ok)
sys.exit(0 if ok else 1)
