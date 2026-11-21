import json
import time
import urllib.request
import websocket

CDP = "http://127.0.0.1:9229"
MOCK = "http://127.0.0.1:8765"

with urllib.request.urlopen(CDP + "/json/list", timeout=10) as r:
    targets = json.load(r)

def find_sw():
    for t in targets:
        if t.get("type") == "service_worker" and t.get("url", "").endswith("/background.js"):
            return t
    return None

# Wake if necessary
sw = find_sw()
if not sw:
    page = next(t for t in targets if t.get("type") == "page" and t.get("url", "").endswith("/options.html"))
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=30, suppress_origin=True)
    ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {
        "expression": "chrome.runtime.sendMessage({type:'getState'},()=>{})",
        "userGesture": True
    }}))
    ws.recv()
    ws.close()
    time.sleep(1)
    with urllib.request.urlopen(CDP + "/json/list", timeout=10) as r:
        targets = json.load(r)
    sw = find_sw()

ws = websocket.create_connection(sw["webSocketDebuggerUrl"], timeout=60, suppress_origin=True)
next_id = 1

def call(method, params):
    global next_id
    i = next_id
    next_id += 1
    ws.send(json.dumps({"id": i, "method": method, "params": params}))
    while True:
        data = json.loads(ws.recv())
        if data.get("id") == i:
            return data

urllib.request.urlopen(urllib.request.Request(MOCK + "/reset", method="POST"), timeout=10).read()

expr = r"""
(async () => {
  await chrome.storage.local.set({
    cooldownUntil: 0,
    settings: {
      baseUrl: 'http://127.0.0.1.nip.io:8765',
      login: 'admin',
      password: 'secret',
      target: { policy: 'HydraRoute', group: 'Youtube', groupIndex: 0 },
      domainMode: 'exact',
      stripWww: false,
      cooldownMs: 10000
    }
  });
  await syncDnrRule(await HRSettings.getSettings());
  await Promise.all([
    handleAdd({ url: 'http://a.127.0.0.1.nip.io:8765/page' }),
    handleAdd({ url: 'http://b.127.0.0.1.nip.io:8765/page' })
  ]);
  return await chrome.storage.local.get(['cooldownUntil', 'lastUndo']);
})()
"""
res = call("Runtime.evaluate", {"expression": expr, "awaitPromise": True, "returnByValue": True, "userGesture": True})
print(json.dumps(res, ensure_ascii=False, indent=2))
state = json.load(urllib.request.urlopen(MOCK + "/state", timeout=10))
print(json.dumps(state, ensure_ascii=False, indent=2))
ws.close()
