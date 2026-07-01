"""Healthcheck — stdlib HTTP /healthcheck endpoint in a daemon thread.

Deliberately uses http.server (NOT aiohttp): it must answer even if the asyncio
loop is momentarily blocked, and it adds no runtime dependency. Reports the live
bot count straight off the BrokerClient.
"""
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Healthcheck:
    def __init__(self, broker) -> None:
        self.broker = broker
        self.port = int(os.environ.get("VISIOBOT_HEALTHCHECK_HTTP", "8081"))
        self.server: ThreadingHTTPServer | None = None
        self.thread: threading.Thread | None = None

    def start(self) -> None:
        broker = self.broker

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                path = self.path.split("?", 1)[0].rstrip("/")
                if path in ("/healthcheck", ""):
                    active = len(broker.bots) if broker is not None else 0
                    body = json.dumps({"status": "ok", "activeBots": active}).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                else:
                    self.send_response(404)
                    self.end_headers()

            def log_message(self, *args):  # silence default stderr access log
                pass

        self.server = ThreadingHTTPServer(("0.0.0.0", self.port), Handler)
        self.thread = threading.Thread(
            target=self.server.serve_forever, name="healthcheck", daemon=True
        )
        self.thread.start()
        print(f"visio-bot-service: healthcheck listening on :{self.port}", flush=True)
