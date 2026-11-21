import argparse
import json
import time
import urllib.request

import websocket

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=9223)
args = parser.parse_args()
CDP = f"http://127.0.0.1:{args.port}"


def targets():
    with urllib.request.urlopen(CDP + "/json/list", timeout=10) as r:
        return json.load(r)


class CDPClient:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=60, suppress_origin=True)
        self.next_id = 1

    def call(self, method, params=None):
        msg_id = self.next_id
        self.next_id += 1
        self.ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
        while True:
            data = json.loads(self.ws.recv())
            if data.get("id") == msg_id:
                return data

    def eval(self, expression):
        response = self.call("Runtime.evaluate", {
            "expression": expression,
            "awaitPromise": True,
            "returnByValue": True,
            "userGesture": True,
        })
        if "exceptionDetails" in response.get("result", {}):
            raise RuntimeError(json.dumps(response["result"]["exceptionDetails"], ensure_ascii=False, indent=2))
        return response.get("result", {}).get("result", {}).get("value")

    def close(self):
        self.ws.close()


def main():
    page = None
    for target in targets():
        if target.get("type") == "page" and target.get("url", "").endswith("/options.html"):
            page = target
            break
    if not page:
        raise SystemExit("options page not found")
    print("options:", page["url"])
    client = CDPClient(page["webSocketDebuggerUrl"])
    client.call("Runtime.enable")

    result = client.eval(r"""
(async () => {
  document.getElementById('base-url').value = 'http://127.0.0.1.nip.io:8765';
  document.getElementById('login').value = 'admin';
  document.getElementById('password').value = 'secret';
  document.getElementById('connect-btn').click();
  let status = '';
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 100));
    status = document.getElementById('connection-status').textContent;
    if (/Подключено|ошибка|Ошибка|Без доступа/.test(status)) break;
  }
  return {
    status,
    pill: document.getElementById('connection-pill').textContent,
    policyCount: document.getElementById('policy-select').options.length,
    groupCount: document.getElementById('group-select').options.length,
    policyDisabled: document.getElementById('policy-select').disabled,
    targetPreview: document.getElementById('target-preview').textContent,
    diagHrweb: document.getElementById('diag-hrweb').textContent,
    diagHrneo: document.getElementById('diag-hrneo').textContent,
    diagSession: document.getElementById('diag-session').textContent,
    passwordHint: document.getElementById('password-hint').textContent
  };
})()
""")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    client.close()


if __name__ == "__main__":
    main()
