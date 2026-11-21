import argparse
import base64
import json
import urllib.request
import websocket

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=9227)
parser.add_argument("--out", default=r"C:\Users\Administrator\AppData\Local\Temp\opencode\options_shot.png")
args = parser.parse_args()
CDP = f"http://127.0.0.1:{args.port}"

with urllib.request.urlopen(CDP + "/json/list", timeout=10) as r:
    targets = json.load(r)
page = next(t for t in targets if t.get("type") == "page" and t.get("url", "").endswith("/options.html"))
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=30, suppress_origin=True)
next_id = 1

def call(method, params=None):
    global next_id
    msg_id = next_id
    next_id += 1
    ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
    while True:
        data = json.loads(ws.recv())
        if data.get("id") == msg_id:
            return data

call("Page.enable")
call("Emulation.setDeviceMetricsOverride", {"width": 1040, "height": 1800, "deviceScaleFactor": 1, "mobile": False})
result = call("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": True})
data = result["result"]["data"]
open(args.out, "wb").write(base64.b64decode(data))
print(args.out)
ws.close()
