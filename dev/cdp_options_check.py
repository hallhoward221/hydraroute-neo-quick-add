import argparse
import json
import time
import urllib.request
import websocket

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=9241)
args = parser.parse_args()
CDP = f"http://127.0.0.1:{args.port}"

for _ in range(20):
    try:
        with urllib.request.urlopen(CDP + "/json/list", timeout=10) as r:
            targets = json.load(r)
        break
    except Exception:
        time.sleep(0.3)
else:
    raise SystemExit("CDP not available")

page = next(t for t in targets if t.get("type") == "page" and t.get("url", "").endswith("/options.html"))
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=30, suppress_origin=True)
ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {
    "expression": "({title: document.title, rknExists: !!document.getElementById('rkn-check'), rknChecked: document.getElementById('rkn-check')?.checked, clearBtn: document.getElementById('clear-rkn-cache')?.textContent, diagRkn: document.getElementById('diag-rkn')?.textContent, status: document.getElementById('connection-status')?.textContent})",
    "returnByValue": True
}}))
while True:
    data = json.loads(ws.recv())
    if data.get("id") == 1:
        print(json.dumps(data, ensure_ascii=False, indent=2))
        break
ws.close()
