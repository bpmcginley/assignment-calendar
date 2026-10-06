"""Preview the app on this computer:  python serve.py   (or  python serve.py --demo)

Builds the data file from config.json, then serves site/ at http://localhost:8765.
"""
import functools
import subprocess
import sys
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).parent
PORT = 8765


def main():
    demo = "--demo" in sys.argv
    if "--no-build" not in sys.argv:
        subprocess.run([sys.executable, str(ROOT / "build.py")] + (["--demo"] if demo else []), check=True)
    handler = functools.partial(SimpleHTTPRequestHandler, directory=str(ROOT / "site"))
    handler.log_message = lambda *a: None
    # Localhost only: the page shows your coursework.
    server = ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    url = f"http://localhost:{PORT}/"
    print(f"Serving {url}" + ("  (demo data, passphrase: demo-passphrase)" if demo else "") + "  - Ctrl+C to stop")
    if "--no-browser" not in sys.argv:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
