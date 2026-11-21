import argparse
import json
import time
import urllib.request

import websocket

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=9233)
args = parser.parse_args()
CDP = f"http://127.0.0.1:{args.port}"
MOCK = "http://127.0.0.1:8765"


def get_json(path):
    with urllib.request.urlopen(CDP + path, timeout=10) as r:
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
    for t in get_json("/json/list"):
        if t.get("type") == "service_worker" and t.get("url", "").endswith("/background.js"):
            return t
    return None


def wake_sw():
    page = None
    for t in get_json("/json/list"):
        if t.get("type") == "page" and t.get("url", "").endswith("/options.html"):
            page = t
            break
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


def main():
    urllib.request.urlopen(urllib.request.Request(MOCK + "/reset", method="POST"), timeout=10).read()
    version = get_json("/json/version")
    browser = connect(version["webSocketDebuggerUrl"])

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
      cooldownMs: 10000
    },
    cooldownUntil: 0
  });
  await syncDnrRule(await HRSettings.getSettings());
  return true;
})()
"""
    worker.eval(setup)

    print("create slow target")
    browser.call("Target.createTarget", {"url": "http://127.0.0.1.nip.io:8765/slow"})
    time.sleep(0.4)

    print("tabs while slow:")
    print(json.dumps(worker.eval("chrome.tabs.query({})"), ensure_ascii=False, indent=2))

    slow_result = worker.eval(r"""
(async () => {
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find(t => (t.pendingUrl || '').includes('/slow'));
  if (!tab) return { error: 'slow tab not found', tabs };
  await handleAdd(tab);
  return { tab, lastError: (await chrome.storage.local.get('lastError')).lastError || null };
})()
""")
    print("slow add:", json.dumps(slow_result, ensure_ascii=False, indent=2))

    print("create error target")
    browser.call("Target.createTarget", {"url": "http://nonexistent.invalid/"})
    time.sleep(2.5)
    error_result = worker.eval(r"""
(async () => {
  await chrome.storage.local.set({ cooldownUntil: 0 });
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find(t => (t.url || '').includes('nonexistent.invalid') || (t.pendingUrl || '').includes('nonexistent.invalid'));
  if (!tab) return { error: 'error tab not found', tabs };
  await handleAdd(tab);
  return { tab, lastError: (await chrome.storage.local.get('lastError')).lastError || null };
})()
""")
    print("error add:", json.dumps(error_result, ensure_ascii=False, indent=2))

    print("create blank target")
    browser.call("Target.createTarget", {"url": "about:blank"})
    time.sleep(0.4)
    blank_result = worker.eval(r"""
(async () => {
  await chrome.storage.local.set({ cooldownUntil: 0 });
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find(t => t.url === 'about:blank');
  if (!tab) return { error: 'blank tab not found' };
  await handleAdd(tab);
  return { tab, lastError: (await chrome.storage.local.get('lastError')).lastError || null };
})()
""")
    print("blank add:", json.dumps(blank_result, ensure_ascii=False, indent=2))

    state = get_json_mock("/state")
    print("mock state:", json.dumps(state, ensure_ascii=False, indent=2))
    browser.close()
    worker.close()


def get_json_mock(path):
    with urllib.request.urlopen(MOCK + path, timeout=10) as r:
        return json.load(r)


if __name__ == "__main__":
    main()
