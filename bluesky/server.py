#!/usr/bin/env python3
"""
JIZURA bluesky-view: Python fallback bridge server
Runs on port 8791 (or custom), serving:
  /             bluesky/www
  /jizura.js    src/*.js concatenated
  /api/timeline Bluesky posts (public or authenticated)
  /api/config   GET/POST configuration
  /api/status   bridge status
  /api/proxy-image  cached avatar image proxy
"""
import sys
import os
import json
import time
import hashlib
import threading
import urllib.request
import urllib.error
import urllib.parse
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = 8791
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
WWW_DIR = os.path.join(SCRIPT_DIR, "www")
SRC_DIR = os.path.join(ROOT_DIR, "src")

APPDATA = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
BASE_DATA = os.path.join(APPDATA, "JizuraBluesky")
CACHE_DIR = os.path.join(BASE_DATA, "cache")
CONFIG_FILE = os.path.join(BASE_DATA, "config.json")

os.makedirs(CACHE_DIR, exist_ok=True)

DEFAULT_CONFIG = {
    "mode": "author",
    "identifier": "bsky.app",
    "password": "",
    "pdsUrl": "",
    "pollIntervalSeconds": 60,
    "displayDurationSeconds": 12
}

config = dict(DEFAULT_CONFIG)
cached_posts = []
last_fetch_time = 0
last_error = None
config_lock = threading.Lock()
fetch_lock = threading.Lock()
access_jwt = None
refresh_jwt = None
resolved_pds = None

def load_config():
    global config
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                loaded = json.load(f)
                config.update(loaded)
        except Exception as e:
            print(f"Error loading config: {e}", file=sys.stderr)

def save_config(new_cfg):
    global config, access_jwt, refresh_jwt, resolved_pds
    with config_lock:
        config.update(new_cfg)
        access_jwt = None
        refresh_jwt = None
        resolved_pds = None
        try:
            with open(CONFIG_FILE, "w", encoding="utf-8") as f:
                json.dump(config, f, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"Error saving config: {e}", file=sys.stderr)

def resolve_did(handle):
    if handle.startswith("did:"):
        return handle
    clean = handle.strip().lstrip("@")
    url = f"https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle={urllib.parse.quote(clean)}"
    req = urllib.request.Request(url, headers={"User-Agent": "JIZURA-Bluesky/1.0"})
    with urllib.request.urlopen(req, timeout=10) as res:
        data = json.loads(res.read().decode("utf-8"))
        return data["did"]

def resolve_pds(did):
    url = f"https://plc.directory/{urllib.parse.quote(did)}"
    req = urllib.request.Request(url, headers={"User-Agent": "JIZURA-Bluesky/1.0"})
    with urllib.request.urlopen(req, timeout=10) as res:
        data = json.loads(res.read().decode("utf-8"))
        for s in data.get("service", []):
            if s.get("id", "").endswith("#atproto_pds"):
                return s.get("serviceEndpoint", "https://bsky.social")
    return "https://bsky.social"

def ensure_session():
    global access_jwt, refresh_jwt, resolved_pds
    if access_jwt:
        return
    clean = config["identifier"].strip().lstrip("@")
    did = resolve_did(clean)
    pds = config.get("pdsUrl") or resolve_pds(did)
    resolved_pds = pds.rstrip("/")
    login_url = f"{resolved_pds}/xrpc/com.atproto.server.createSession"
    payload = json.dumps({"identifier": clean, "password": config["password"]}).encode("utf-8")
    req = urllib.request.Request(login_url, data=payload, headers={"Content-Type": "application/json", "User-Agent": "JIZURA-Bluesky/1.0"})
    with urllib.request.urlopen(req, timeout=15) as res:
        data = json.loads(res.read().decode("utf-8"))
        access_jwt = data["accessJwt"]
        refresh_jwt = data.get("refreshJwt")

def parse_feed(data):
    posts = []
    feed = data.get("feed", [])
    def extract_images(emb):
        imgs = []
        if not emb or not isinstance(emb, dict):
            return imgs
        # 1. 直接の画像 (app.bsky.embed.images#view)
        if "images" in emb and isinstance(emb["images"], list):
            for img in emb["images"]:
                url = img.get("fullsize") or img.get("thumb")
                if url:
                    imgs.append(url)
        # 2. 引用＋メディア (app.bsky.embed.recordWithMedia#view)
        elif "media" in emb and isinstance(emb["media"], dict):
            imgs.extend(extract_images(emb["media"]))
        # 3. 外部カードのサムネイル
        elif "external" in emb and isinstance(emb["external"], dict):
            thumb = emb["external"].get("thumb")
            if thumb:
                imgs.append(thumb)
        return imgs

    for item in feed:
        post = item.get("post", {})
        author = post.get("author", {})
        record = post.get("record", {})
        text = record.get("text", "").strip()
        embed = post.get("embed", {})
        images = extract_images(embed)
        if not images and "record" in post and isinstance(post["record"], dict):
            rec_emb = post["record"].get("embed", {})
            if "images" in rec_emb and isinstance(rec_emb["images"], list):
                did = author.get("did")
                for img in rec_emb["images"]:
                    blob = img.get("image", {}).get("ref", {}).get("$link")
                    if blob and did:
                        images.append(f"https://cdn.bsky.app/img/feed_fullsize/plain/{did}/{blob}")


        if not text and images:
            author_name = author.get("displayName") or author.get("handle") or ""
            text = f"{author_name} 🦋"

        if not text:
            continue

        posts.append({
            "uri": post.get("uri", ""),
            "cid": post.get("cid", ""),
            "authorName": author.get("displayName") or author.get("handle") or "",
            "authorHandle": author.get("handle", ""),
            "authorAvatar": author.get("avatar"),
            "text": text,
            "images": images,
            "createdAt": record.get("createdAt", ""),
            "replyCount": post.get("replyCount", 0),
            "repostCount": post.get("repostCount", 0),
            "likeCount": post.get("likeCount", 0)
        })
    return posts


def fetch_timeline():
    global cached_posts, last_fetch_time, last_error, access_jwt
    if not fetch_lock.acquire(blocking=False):
        return
    try:
        mode = config.get("mode", "author")
        ident = config.get("identifier", "").strip()
        pwd = config.get("password", "").strip()
        if mode == "timeline" and ident and pwd:
            ensure_session()
            url = f"{resolved_pds}/xrpc/app.bsky.feed.getTimeline?limit=30"
            req = urllib.request.Request(url, headers={"Authorization": f"Bearer {access_jwt}", "User-Agent": "JIZURA-Bluesky/1.0"})
            try:
                with urllib.request.urlopen(req, timeout=15) as res:
                    data = json.loads(res.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                if e.code == 401:
                    access_jwt = None
                    ensure_session()
                    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {access_jwt}", "User-Agent": "JIZURA-Bluesky/1.0"})
                    with urllib.request.urlopen(req, timeout=15) as res:
                        data = json.loads(res.read().decode("utf-8"))
                else:
                    raise
            posts = parse_feed(data)
        else:
            clean = ident or "bsky.app"
            url = f"https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor={urllib.parse.quote(clean)}&limit=30"
            req = urllib.request.Request(url, headers={"User-Agent": "JIZURA-Bluesky/1.0"})
            with urllib.request.urlopen(req, timeout=15) as res:
                data = json.loads(res.read().decode("utf-8"))
            posts = parse_feed(data)
        cached_posts = posts
        last_fetch_time = time.time()
        last_error = None
    except Exception as e:
        last_error = str(e)
        print(f"Fetch error: {e}", file=sys.stderr)
    finally:
        fetch_lock.release()

def background_loop():
    while True:
        fetch_timeline()
        interval = max(10, int(config.get("pollIntervalSeconds", 60)))
        time.sleep(interval)

def build_engine():
    files = sorted([os.path.join(SRC_DIR, f) for f in os.listdir(SRC_DIR) if f.endswith(".js")])
    version_file = os.path.join(ROOT_DIR, "VERSION")
    version = "dev"
    if os.path.exists(version_file):
        with open(version_file, "r", encoding="utf-8") as f:
            version = f.read().strip()
    parts = []
    for f in files:
        with open(f, "r", encoding="utf-8") as fp:
            parts.append(fp.read())
    return "\n".join(parts).replace("@VERSION@", version)

class RequestHandler(BaseHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        path = url.path
        query = urllib.parse.parse_qs(url.query)

        if path == "/jizura.js":
            content = build_engine().encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(content)
        elif path == "/api/timeline":
            if query.get("refresh", ["0"])[0] == "1":
                fetch_timeline()
            res = {
                "posts": cached_posts,
                "lastFetchTime": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(last_fetch_time)) if last_fetch_time else None,
                "pollIntervalSeconds": config.get("pollIntervalSeconds", 60),
                "displayDurationSeconds": config.get("displayDurationSeconds", 12),
                "error": last_error
            }
            body = json.dumps(res, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        elif path == "/api/config":
            res = {
                "mode": config.get("mode"),
                "identifier": config.get("identifier"),
                "hasPassword": bool(config.get("password")),
                "pdsUrl": config.get("pdsUrl"),
                "pollIntervalSeconds": config.get("pollIntervalSeconds", 60),
                "displayDurationSeconds": config.get("displayDurationSeconds", 12)
            }
            body = json.dumps(res, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(body)
        elif path == "/api/status":
            res = {
                "lastFetchTime": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(last_fetch_time)) if last_fetch_time else None,
                "error": last_error,
                "pollIntervalSeconds": config.get("pollIntervalSeconds", 60),
                "mode": config.get("mode"),
                "identifier": config.get("identifier")
            }
            body = json.dumps(res, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(body)
        elif path == "/api/proxy-image":
            img_url = query.get("url", [""])[0]
            if not img_url:
                self.send_error(400, "url query required")
                return
            h = hashlib.sha256(img_url.encode("utf-8")).hexdigest()
            cache_file = os.path.join(CACHE_DIR, h + ".bin")
            meta_file = os.path.join(CACHE_DIR, h + ".meta")
            if os.path.exists(cache_file) and os.path.exists(meta_file):
                with open(cache_file, "rb") as f:
                    data = f.read()
                with open(meta_file, "r") as f:
                    ctype = f.read().strip()
            else:
                try:
                    req = urllib.request.Request(img_url, headers={"User-Agent": "JIZURA-Bluesky/1.0"})
                    with urllib.request.urlopen(req, timeout=10) as r:
                        data = r.read()
                        ctype = r.headers.get("Content-Type", "image/jpeg")
                    with open(cache_file, "wb") as f:
                        f.write(data)
                    with open(meta_file, "w") as f:
                        f.write(ctype)
                except Exception as e:
                    self.send_error(502, f"Failed to fetch image: {e}")
                    return
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "public, max-age=86400")
            self.end_headers()
            self.wfile.write(data)
        else:
            req_path = path.lstrip("/") or "index.html"
            file_path = os.path.normpath(os.path.join(WWW_DIR, req_path))
            if not file_path.startswith(WWW_DIR) or not os.path.exists(file_path):
                self.send_error(404, "File not found")
                return
            ext = os.path.splitext(file_path)[1].lower()
            ct_map = {
                ".html": "text/html; charset=utf-8",
                ".js": "text/javascript; charset=utf-8",
                ".css": "text/css; charset=utf-8",
                ".svg": "image/svg+xml",
                ".png": "image/png",
                ".webp": "image/webp"
            }
            self.send_response(200)
            self.send_header("Content-Type", ct_map.get(ext, "application/octet-stream"))
            self.end_headers()
            with open(file_path, "rb") as f:
                self.wfile.write(f.read())

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        if url.path == "/api/config":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode("utf-8")
            try:
                new_cfg = json.loads(body)
                save_config(new_cfg)
                threading.Thread(target=fetch_timeline, daemon=True).start()
                res = {"success": True, "config": config}
                out = json.dumps(res, ensure_ascii=False).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(out)
            except Exception as e:
                self.send_error(400, f"Invalid JSON: {e}")
        else:
            self.send_error(404)

def main():
    load_config()
    t = threading.Thread(target=background_loop, daemon=True)
    t.start()
    server = HTTPServer(("127.0.0.1", PORT), RequestHandler)
    print(f"JIZURA bluesky-view: http://localhost:{PORT}/")
    print(f"  root: {ROOT_DIR}")
    print(f"  Bluesky タイムラインを {config.get('pollIntervalSeconds', 60)} 秒ごとに確認します。終了は Ctrl+C。")
    try:
        import webbrowser
        webbrowser.open(f"http://localhost:{PORT}/")
    except Exception:
        pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutdown.")

if __name__ == "__main__":
    main()
