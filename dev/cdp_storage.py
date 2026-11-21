import argparse
import json
import urllib.request
import websocket

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=9223)
args = parser.parse_args()
CDP = f"http://127.0.0.1:{args.port}"

with urllib.request.urlopen(CDP + "/json/list", timeout=10) as r:
    targets = json.load(r)

page = next(t for t in targets if t.get("type") == "page" and t.get("url", "").endswith("/options.html"))
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=30, suppress_origin=True)
ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {
    "expression": "(async () => await chrome.storage.local.get(['lastError','settings']))()",
    "awaitPromise": True,
    "returnByValue": True
}}))
while True:
    data = json.loads(ws.recv())
    if data.get("id") == 1:
        print(json.dumps(data, ensure_ascii=False, indent=2))
        break
ws.close()
