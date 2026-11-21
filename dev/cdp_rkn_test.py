import argparse
import json
import time
import urllib.request

import websocket

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=9235)
args = parser.parse_args()
CDP = f"http://127.0.0.1:{args.port}"
MOCK = "http://127.0.0.1:8765"


def get_json(url):
    with urllib.request.urlopen(url, timeout=10) as r:
        return json.load(r)


class C:
    def __init__(self, ws):
        self.ws = ws
        self.i = 1

    def call(self, method, params=None):
        i = self.i
        self.i += 1
        self.ws.send(json.dumps({"id": i, "method": method, "params": params or {}}))
        while True:
            data = json.loads(self.ws.recv())
            if data.get("id") == i:
                return data

    def eval(self, expr):
        response = self.call("Runtime.evaluate", {
            "expression": expr,
            "awaitPromise": True,
            "returnByValue": True,
            "userGesture": True
        })
        if "exceptionDetails" in response.get("result", {}):
            raise RuntimeError(json.dumps(response["result"]["exceptionDetails"], ensure_ascii=False, indent=2))
        return response["result"]["result"].get("value")

    def close(self):
        self.ws.close()


def connect(url):
    return C(websocket.create_connection(url, timeout=60, suppress_origin=True))


def find_sw():
    for t in get_json(CDP + "/json/list"):
        if t.get("type") == "service_worker" and t.get("url", "").endswith("/background.js"):
            return t
    return None


def wake_sw():
    page = next((t for t in get_json(CDP + "/json/list") if t.get("type") == "page" and t.get("url", "").endswith("/options.html")), None)
    if not page:
        return None
    c = connect(page["webSocketDebuggerUrl"])
    c.eval("chrome.runtime.sendMessage({type:'getState'},()=>{})")
    c.close()
    for _ in range(50):
        sw = find_sw()
        if sw:
            return sw
        time.sleep(0.2)
    return None


def mock_state():
    return get_json(MOCK + "/state")


def wait_until(predicate, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.25)
    return False


def debug_rkn_tab():
    try:
        for t in get_json(CDP + "/json/list"):
            if t.get("type") == "page" and "/rkn/" in t.get("url", ""):
                print("RKN TAB", t.get("url"))
                try:
                    c = connect(t["webSocketDebuggerUrl"])
                    info = c.eval("({marker: document.documentElement.dataset.hrneoRkn || null, text: document.body.innerText.slice(0,800), title: document.title, url: location.href})")
                    print(json.dumps(info, ensure_ascii=False, indent=2))
                    c.close()
                except Exception as e:
                    print("tab eval error", e)
    except Exception as e:
        print("debug error", e)


def main():
    urllib.request.urlopen(urllib.request.Request(MOCK + "/reset", method="POST"), timeout=10).read()
    sw = find_sw() or wake_sw()
    if not sw:
        raise SystemExit("service worker not found")
    worker = connect(sw["webSocketDebuggerUrl"])

    setup = r"""
(async () => {
  await chrome.storage.local.set({
    settings: {
      baseUrl: 'http://127.0.0.1.nip.io:8765',
      login: 'admin',
      password: 'secret',
      target: { policy: 'HydraRoute', group: 'Youtube', groupIndex: 0 },
      domainMode: 'exact',
      stripWww: false,
      rknCheck: true,
      cooldownMs: 10000
    },
    cooldownUntil: 0
  });
  await chrome.storage.local.remove('rknCache');
  await chrome.storage.local.remove('lastError');
  await chrome.storage.session.remove('rknJob');
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id && tab.url && tab.url.includes('/rkn/')) {
      try { await chrome.tabs.remove(tab.id); } catch (e) {}
    }
  }
  await syncDnrRule(await HRSettings.getSettings());
  return true;
})()
"""
    worker.eval(setup)

    def job():
        return worker.eval("(async () => (await chrome.storage.session.get('rknJob')).rknJob || null)()")

    def clear_cooldown():
        worker.eval("chrome.storage.local.set({cooldownUntil: 0})")

    print("1) found domain")
    worker.eval("handleAdd({url: 'https://instagram.com/'})")
    ok = wait_until(lambda: "instagram.com/HydraRoute" in mock_state()["domainFile"], 20)
    print("added:", ok, "job:", job())
    if not ok:
        debug_rkn_tab()
        print("storage:", json.dumps(worker.eval("(async () => await chrome.storage.local.get(['lastError','lastRknError','rknCache']))()"), ensure_ascii=False, indent=2))
    print(json.dumps(mock_state(), ensure_ascii=False, indent=2))
    assert ok, "found domain was not added"

    print("2) not found domain")
    clear_cooldown()
    before = mock_state()["restartCount"]
    worker.eval("handleAdd({url: 'https://example.com/'})")
    ok = wait_until(lambda: job() is None, 20)
    state = mock_state()
    print("job gone:", ok, "restart:", state["restartCount"], "example present:", "example.com/HydraRoute" in state["domainFile"])
    assert ok and state["restartCount"] == before and "example.com/HydraRoute" not in state["domainFile"], "not-found domain was added"

    print("3) exact not found, root found")
    clear_cooldown()
    worker.eval("handleAdd({url: 'https://music.example.org/'})")
    ok = wait_until(lambda: "music.example.org/HydraRoute" in mock_state()["domainFile"], 25)
    print("added:", ok, "job:", job())
    print(json.dumps(mock_state(), ensure_ascii=False, indent=2))
    assert ok, "root fallback did not add the exact site"

    print("4) challenge")
    clear_cooldown()
    before = mock_state()["restartCount"]
    worker.eval("handleAdd({url: 'https://challenge.test/'})")
    ok = wait_until(lambda: (job() or {}).get("stage") == "challenge", 15)
    j = job()
    print("challenge detected:", ok, "job:", j)
    assert ok, "challenge was not detected"
    if j and j.get("tabId"):
        worker.eval(f"chrome.tabs.remove({j['tabId']})")
        wait_until(lambda: job() is None, 5)
    state = mock_state()
    print("restart after challenge:", state["restartCount"])
    assert state["restartCount"] == before

    print("5) cache")
    cache = worker.eval("(async () => (await chrome.storage.local.get('rknCache')).rknCache || {})()")
    print(json.dumps(cache, ensure_ascii=False, indent=2))
    assert cache.get("instagram.com", {}).get("found") is True
    assert cache.get("example.com", {}).get("found") is False
    assert cache.get("music.example.org", {}).get("found") is True
    assert cache.get("example.org", {}).get("found") is True

    print("6) check-only")
    clear_cooldown()
    before = mock_state()["restartCount"]
    worker.eval("handleAdd({url: 'https://check-only.test/'}, {checkOnly: true})")
    ok = wait_until(lambda: job() is None, 20)
    cache = worker.eval("(async () => (await chrome.storage.local.get('rknCache')).rknCache || {})()")
    print("job gone:", ok, "cache:", cache.get("check-only.test"), "restart:", mock_state()["restartCount"])
    assert ok and cache.get("check-only.test", {}).get("found") is False
    assert mock_state()["restartCount"] == before
    time.sleep(1)
    rkn_tabs = [t for t in get_json(CDP + "/json/list") if t.get("type") == "page" and "/rkn/" in t.get("url", "")]
    print("rkn tabs left:", [t.get("url") for t in rkn_tabs])
    assert not rkn_tabs, "background 2whois tab was not closed"

    print("OK")
    worker.close()


if __name__ == "__main__":
    main()

