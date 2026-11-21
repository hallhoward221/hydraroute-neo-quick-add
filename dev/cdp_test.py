import argparse
import json
import time
import urllib.request

import websocket

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=9223)
args = parser.parse_args()
CDP = f"http://127.0.0.1:{args.port}"
MOCK = "http://127.0.0.1:8765"


def get_targets():
    with urllib.request.urlopen(CDP + "/json/list", timeout=10) as r:
        return json.load(r)


def find_workspace():
    for target in get_targets():
        if target.get("type") == "service_worker" and target.get("url", "").endswith("/background.js"):
            return target
    return None


def wake_service_worker():
    page = None
    for target in get_targets():
        if target.get("type") == "page" and target.get("url", "").endswith("/options.html"):
            page = target
            break
    if not page:
        raise SystemExit("Options page target not found")
    client = CDPClient(page["webSocketDebuggerUrl"])
    client.call("Runtime.enable")
    client.eval(r"""
(async () => {
  return await new Promise(resolve => chrome.runtime.sendMessage({ type: 'getState' }, resolve));
})()
""")
    client.close()
    for _ in range(50):
        target = find_workspace()
        if target:
            return target
        time.sleep(0.2)
    return None


class CDPClient:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=60, suppress_origin=True)
        self.next_id = 1

    def call(self, method, params=None):
        msg_id = self.next_id
        self.next_id += 1
        self.ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
        while True:
            raw = self.ws.recv()
            data = json.loads(raw)
            if data.get("id") == msg_id:
                return data
            # Ignore events.

    def eval(self, expression, await_promise=True, return_by_value=True):
        response = self.call("Runtime.evaluate", {
            "expression": expression,
            "awaitPromise": await_promise,
            "returnByValue": return_by_value,
            "userGesture": True,
        })
        if "exceptionDetails" in response.get("result", {}):
            raise RuntimeError(json.dumps(response["result"]["exceptionDetails"], ensure_ascii=False, indent=2))
        result = response.get("result", {}).get("result", {})
        if result.get("subtype") == "error":
            raise RuntimeError(result.get("description") or "JS error")
        return result.get("value")

    def close(self):
        self.ws.close()


def mock_json(path):
    with urllib.request.urlopen(MOCK + path, timeout=20) as r:
        return json.load(r)


def main():
    target = find_workspace() or wake_service_worker()
    if not target:
        raise SystemExit("Service worker target not found")
    print("service worker:", target["url"])
    client = CDPClient(target["webSocketDebuggerUrl"])
    client.call("Runtime.enable")

    # Reset mock state
    req = urllib.request.Request(MOCK + "/reset", method="POST")
    urllib.request.urlopen(req, timeout=10).read()

    expr = r"""
(async () => {
  const settings = {
    baseUrl: 'http://127.0.0.1.nip.io:8765',
    login: 'admin',
    password: 'secret',
    target: { policy: 'HydraRoute', group: 'Youtube', groupIndex: 0 },
    domainMode: 'exact',
    stripWww: false,
    cooldownMs: 10000
  };
  await chrome.storage.local.set({ settings });
  await syncDnrRule(await HRSettings.getSettings());
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  await handleAdd({ url: 'http://127.0.0.1.nip.io:8765/page' });
  const after = await chrome.storage.local.get(['cooldownUntil', 'lastUndo', 'lastError']);
  return { rules, after };
})()
"""
    result = client.eval(expr)
    print("first add:", json.dumps(result, ensure_ascii=False, indent=2))

    state = mock_json("/state")
    print("mock state after add:", json.dumps(state, ensure_ascii=False, indent=2))
    assert "127.0.0.1.nip.io/HydraRoute" in state["domainFile"], "domain was not saved"
    assert state["restartCount"] == 1, state["restartCount"]

    dump = mock_json("/dump")
    api_calls = [item for item in dump if item["path"] == "/api"]
    print("api calls:", len(api_calls))
    for item in api_calls:
        headers = {k.lower(): v for k, v in item["headers"].items()}
        print(item["body"][:120], "origin=", headers.get("origin"), "referer=", headers.get("referer"), "cookie=", bool(headers.get("cookie")))
    assert all(not {k.lower() for k in item["headers"]} & {"origin", "referer"} for item in api_calls), "Origin/Referer still present"

    # Second click immediately: cooldown must block it.
    client.eval(r"""
(async () => {
  await handleAdd({ url: 'http://127.0.0.1.nip.io:8765/page' });
  return true;
})()
""")
    state2 = mock_json("/state")
    print("restart count after cooldown click:", state2["restartCount"])
    assert state2["restartCount"] == 1, "cooldown did not block the second add"

    # Clear cooldown; duplicate must be blocked without config.save.
    client.eval(r"""
(async () => {
  await chrome.storage.local.set({ cooldownUntil: 0 });
  await handleAdd({ url: 'http://127.0.0.1.nip.io:8765/page' });
  return true;
})()
""")
    state3 = mock_json("/state")
    print("restart count after duplicate click:", state3["restartCount"])
    assert state3["restartCount"] == 1, "duplicate caused a save"

    # Undo must restore the previous file and restart once.
    client.eval(r"""
(async () => {
  await chrome.storage.local.set({ cooldownUntil: 0 });
  await undoLast();
  return true;
})()
""")
    state4 = mock_json("/state")
    print("restart count after undo:", state4["restartCount"])
    print("domain file after undo:\n" + state4["domainFile"])
    assert state4["restartCount"] == 2, "undo did not save"
    assert "127.0.0.1.nip.io/HydraRoute" not in state4["domainFile"], "undo did not remove the domain"

    storage = client.eval(r"""
(async () => {
  return await chrome.storage.local.get(['lastError', 'lastUndo', 'cooldownUntil']);
})()
""")
    print("storage:", json.dumps(storage, ensure_ascii=False, indent=2))
    print("OK")
    client.close()


if __name__ == "__main__":
    main()

