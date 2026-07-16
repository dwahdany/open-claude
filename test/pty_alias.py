# /// script
# requires-python = ">=3.10"
# dependencies = ["pexpect"]
# ///
"""Drive the first-run alias offer end-to-end in a real PTY: fresh state → prompt →
answer y → rc appended + state marked → second run must boot without prompting.
Scratch XDG_DATA_HOME/ZDOTDIR keep the real machine state and ~/.zshrc untouched."""
import json
import os
import sys
import tempfile

import pexpect

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
scratch = tempfile.mkdtemp(prefix="oc-pty-alias-")
home = os.path.join(scratch, "home")
os.makedirs(home)
env = dict(
    os.environ,
    TERM="xterm-256color",
    SHELL="/bin/zsh",
    XDG_DATA_HOME=os.path.join(scratch, "data"),
    ZDOTDIR=home,
)
env.pop("OPENCLAUDE_NO_ALIAS_PROMPT", None)

failures: list[str] = []


def check(name: str, ok: bool, detail: str = ""):
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail and not ok else ""))
    if not ok:
        failures.append(name)


def boot(expect_prompt: bool) -> None:
    child = pexpect.spawn(
        "bun",
        ["index.ts", "--serve", "--directory", os.path.join(scratch, "proj")],
        cwd=REPO,
        env=env,
        encoding="utf-8",
        timeout=30,
    )
    if expect_prompt:
        i = child.expect([r"\[y/N\]", r"listening on"])
        check("first run prompts before serving", i == 0, child.before or "")
        child.sendline("y")
        child.expect(r"added to .*\.zshrc")
        child.expect(r"listening on")
    else:
        i = child.expect([r"listening on", r"\[y/N\]"])
        check("second run boots without prompting", i == 0, child.before or "")
    child.terminate(force=True)


boot(expect_prompt=True)

rc = os.path.join(home, ".zshrc")
body = open(rc).read() if os.path.exists(rc) else "<missing>"
check("rc file gained the alias line", "alias oclaude=" in body and "# added by open-claude" in body, body)

state_path = os.path.join(env["XDG_DATA_HOME"], "open-claude", "state.json")
state = json.load(open(state_path)) if os.path.exists(state_path) else {}
check("state.json marks aliasOffered", state.get("aliasOffered") is True, repr(state))

boot(expect_prompt=False)

print(f"\nrc line: {[l for l in body.splitlines() if 'oclaude' in l]}")
sys.exit(1 if failures else 0)
