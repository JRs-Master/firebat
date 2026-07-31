"""Client for the module-call path — how a Python sysmod reaches another module.

The framework hands a module a one-shot token in `FIREBAT_RPC_TOKEN` when (and only when) its
config.json declares `dependencies`. The token is scoped to that declaration, dies with the
process, and carries whether this run was already approved. Everything here is a thin wrapper over
the MCP endpoint that already exists — no new protocol to learn.

    import firebat_call as fb

    if fb.available():
        res = fb.call("kiwoom", {"action": "kt00018", "account": "real-1"})
        if not res["success"]:
            ...   # res["code"] says which rule refused, if it was a rule

A denial is a normal result, not an exception: `module_call_denied` (not declared),
`module_call_depth`, `module_call_budget`, `module_call_recursion`, `approval_required`. A module
that cannot reach the path at all (`available()` is False) should fall back to working from what
it was passed — that is the same code path a pipeline drives, so it stays exercised.
"""
import json
import os
import urllib.error
import urllib.request

_ID = [0]


def available():
    """True when this run was given a call token."""
    return bool(os.environ.get("FIREBAT_RPC_TOKEN") and os.environ.get("FIREBAT_RPC_URL"))


def unattended():
    """True when nobody is waiting on the other end (cron, schedule).

    Anything that spends money should read this: an interactive run is not the run that was
    approved.
    """
    return os.environ.get("FIREBAT_UNATTENDED") == "1"


def module_name():
    return os.environ.get("FIREBAT_MODULE_NAME") or ""


def _rpc(tool, arguments, timeout):
    _ID[0] += 1
    body = json.dumps({
        "jsonrpc": "2.0", "id": _ID[0], "method": "tools/call",
        "params": {"name": tool, "arguments": arguments},
    }).encode("utf-8")
    req = urllib.request.Request(
        os.environ["FIREBAT_RPC_URL"],
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + os.environ["FIREBAT_RPC_TOKEN"],
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _envelope(payload):
    """MCP wraps a tool result in `content[0].text`; unwrap to the module's own envelope."""
    result = (payload or {}).get("result") or {}
    blocks = result.get("content") or []
    if not blocks:
        return {"success": False, "error": "empty tool result", "code": "empty_result"}
    try:
        inner = json.loads(blocks[0].get("text") or "null")
    except (ValueError, TypeError):
        return {"success": False, "error": "tool result was not JSON", "code": "bad_result"}
    if isinstance(inner, dict) and "success" in inner:
        return inner
    if isinstance(inner, dict) and "error" in inner:
        return {"success": False, "error": inner["error"], "code": inner.get("code", "tool_error")}
    return {"success": True, "data": inner}


def call_tool(tool, arguments=None, timeout=30):
    """Call a built-in tool by name (it must be in `dependencies.tools`)."""
    if not available():
        return {"success": False, "error": "module-call path unavailable in this run",
                "code": "unavailable"}
    try:
        return _envelope(_rpc(tool, arguments or {}, timeout))
    except urllib.error.HTTPError as e:
        # 401 means the token expired or was never scoped for this — worth distinguishing from a
        # transport failure, because retrying will not help.
        return {"success": False, "error": f"HTTP {e.code}", "code":
                "unauthorized" if e.code == 401 else "http_error"}
    except Exception as e:  # noqa: BLE001 — a transport failure must not crash the caller
        return {"success": False, "error": f"{type(e).__name__}: {e}", "code": "transport"}


def call(module, arguments=None, timeout=30):
    """Call another module (it must be in `dependencies.modules`, or match a declared capability).

    Never retried here, on purpose. A retry is safe for a query and unsafe for an order, and this
    layer cannot tell them apart — the caller knows which it sent.
    """
    return call_tool("sysmod_" + str(module).replace("-", "_"), arguments, timeout)
