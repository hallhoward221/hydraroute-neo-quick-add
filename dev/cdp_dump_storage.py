import json
import time
import urllib.request
import websocket

CDP = "http://127.0.0.1:9235"

def get_json(url):
    with urllib.request.urlopen(url, timeout=10) as r:
        return json.load(r)

def connect(url):
    return websocket.create_connection(url, timeout=30, suppress_origin=True)

def eval_ws(ws, expr):
    ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {"expression": expr, "awaitPromise": True, "returnByValue": True, "userGesture": True}}))
    while True:
        data = json.loads(ws.recv())
        if data.get("id") == 1:
            return data

targets = get_json(CDP + "/json/list")
sw = next((t for t in targets if t.get("type") == "service_worker" and t.get("url", "").endswith("/background.js")), None)
if not sw:
    page = next((t for t in targets if t.get("type") == "page" and t.get("url", "").endswith("/options.html")), None)
    ws = connect(page["webSocketDebuggerUrl"])
    eval_ws(ws, "chrome.runtime.sendMessage({type:'getState'},()=>{})")
    ws.close()
    time.sleep(1)
    targets = get_json(CDP + "/json/list")
    sw = next(t for t in targets if t.get("type") == "service_worker" and t.get("url", "").endswith("/background.js"))
ws = connect(sw["webSocketDebuggerUrl"])
for expr in [
    "(async () => await chrome.storage.local.get(null))()",
    "(async () => await chrome.storage.session.get(null))()",
    "(async () => await chrome.storage.local.get('lastError'))()"
]:
    print(expr)
    print(json.dumps(eval_ws(ws, expr), ensure_ascii=False, indent=2))
ws.close()
