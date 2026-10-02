export const BROWSER_BRIDGE_SCRIPT = String.raw`
import asyncio
import itertools
import json
import os
import re
import sys
import tempfile
import time
from urllib.parse import urlparse

proto = sys.stdout
sys.stdout = sys.stderr


def send(obj):
    proto.write(json.dumps(obj, default=str) + "\n")
    proto.flush()


try:
    from camoufox.async_api import AsyncCamoufox
except Exception as exc:
    send({"event": "ready", "error": "camoufox is not importable: %s" % exc})
    sys.exit(1)

MAX_BODY = 1024 * 1024
HEADER_VALUE_LIMIT = 4000
TEXT_MARKERS = ("json", "text", "xml", "javascript", "x-www-form-urlencoded", "graphql", "html", "ndjson")
BODY_TYPES = {"xhr", "fetch", "document", "other", "eventsource", "websocket"}
API_TYPES = {"xhr", "fetch", "websocket", "eventsource"}
LOG_LIMIT = 6000
NOISE_HEADERS = {"sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user", "priority", "te", "host", "content-length", "connection", "accept-encoding", "keep-alive"}


class State:
    def __init__(self):
        self.cm = None
        self.browser = None
        self.context = None
        self.pages = {}
        self.tab_of = {}
        self.current = None
        self.tab_ids = itertools.count(1)
        self.seq = itertools.count(1)
        self.log = []
        self.pending = {}
        self.recording = True
        self.headless = True


S = State()


def clip(text, limit):
    if text is None:
        return None
    if len(text) <= limit:
        return text
    return text[:limit] + "... [%d more chars]" % (len(text) - limit)


def is_text_mime(mime):
    lowered = (mime or "").lower()
    return any(marker in lowered for marker in TEXT_MARKERS)


def decode(data):
    if data is None:
        return None
    if isinstance(data, str):
        return data
    return data.decode("utf-8", errors="replace")


def tab_id_of(page):
    return S.tab_of.get(page)


def trim_log():
    if len(S.log) > LOG_LIMIT:
        del S.log[: len(S.log) - LOG_LIMIT]


def entry_for(request):
    return S.pending.get(request)


def on_request(request):
    if not S.recording:
        return
    try:
        page = request.frame.page
    except Exception:
        page = None
    post = None
    try:
        post = request.post_data
    except Exception:
        try:
            buf = request.post_data_buffer
            post = "<binary %d bytes>" % len(buf) if buf else None
        except Exception:
            post = None
    entry = {
        "id": next(S.seq),
        "t": int(time.time() * 1000),
        "tab": tab_id_of(page),
        "method": request.method,
        "url": request.url,
        "type": request.resource_type,
        "navigation": request.is_navigation_request(),
        "request_headers": dict(request.headers),
        "post": post,
        "status": None,
        "status_text": None,
        "response_headers": None,
        "mime": None,
        "body": None,
        "body_size": None,
        "body_truncated": False,
        "duration": None,
        "failure": None,
        "redirected_from": request.redirected_from.url if request.redirected_from else None,
        "ws_frames": None,
        "tag": None,
    }
    S.log.append(entry)
    S.pending[request] = entry
    trim_log()


async def on_response(response):
    entry = entry_for(response.request)
    if entry is None:
        return
    entry["status"] = response.status
    entry["status_text"] = response.status_text
    try:
        entry["response_headers"] = await response.all_headers()
    except Exception:
        entry["response_headers"] = dict(response.headers)
    entry["mime"] = (entry["response_headers"] or {}).get("content-type")


async def on_finished(request):
    entry = S.pending.pop(request, None)
    if entry is None:
        return
    try:
        entry["request_headers"] = await request.all_headers()
    except Exception:
        pass
    try:
        timing = request.timing
        if timing and timing.get("responseEnd", -1) >= 0:
            entry["duration"] = round(timing["responseEnd"])
    except Exception:
        pass
    if entry["type"] not in BODY_TYPES:
        return
    try:
        response = await request.response()
        if response is None:
            return
        if entry["mime"] is None or not is_text_mime(entry["mime"]):
            if entry["type"] not in ("xhr", "fetch") or entry["mime"]:
                return
        data = await response.body()
        entry["body_size"] = len(data)
        if len(data) > MAX_BODY:
            entry["body_truncated"] = True
            data = data[:MAX_BODY]
        entry["body"] = decode(data)
    except Exception:
        pass


def on_failed(request):
    entry = S.pending.pop(request, None)
    if entry is not None:
        entry["failure"] = request.failure


def on_websocket(ws):
    if not S.recording:
        return
    entry = {
        "id": next(S.seq),
        "t": int(time.time() * 1000),
        "tab": None,
        "method": "WS",
        "url": ws.url,
        "type": "websocket",
        "navigation": False,
        "request_headers": {},
        "post": None,
        "status": 101,
        "status_text": "Switching Protocols",
        "response_headers": None,
        "mime": None,
        "body": None,
        "body_size": None,
        "body_truncated": False,
        "duration": None,
        "failure": None,
        "redirected_from": None,
        "ws_frames": [],
        "tag": None,
    }
    S.log.append(entry)
    trim_log()

    def add(direction, payload):
        frames = entry["ws_frames"]
        if len(frames) >= 300:
            return
        frames.append({"dir": direction, "data": clip(decode(payload), 4000)})

    ws.on("framesent", lambda payload: add("out", payload))
    ws.on("framereceived", lambda payload: add("in", payload))


def register_page(page):
    tab = next(S.tab_ids)
    S.pages[tab] = page
    S.tab_of[page] = tab
    S.current = tab
    page.on("websocket", on_websocket)

    def closed(_page=None):
        S.pages.pop(tab, None)
        S.tab_of.pop(page, None)
        if S.current == tab:
            S.current = next(iter(S.pages), None)

    page.on("close", closed)


def parse_proxy(value):
    if not value:
        return None
    parsed = urlparse(value)
    if not parsed.hostname:
        return {"server": value}
    server = "%s://%s" % (parsed.scheme or "http", parsed.hostname)
    if parsed.port:
        server += ":%d" % parsed.port
    proxy = {"server": server}
    if parsed.username:
        proxy["username"] = parsed.username
    if parsed.password:
        proxy["password"] = parsed.password
    return proxy


async def ensure(args=None):
    if S.context is not None:
        return
    args = args or {}
    options = {"headless": args.get("headless", True)}
    S.headless = options["headless"]
    if args.get("humanize"):
        options["humanize"] = True
    if args.get("os"):
        options["os"] = args["os"]
    if args.get("locale"):
        options["locale"] = args["locale"]
    if args.get("geoip"):
        options["geoip"] = True
    if args.get("block_images"):
        options["block_images"] = True
    if args.get("block_webrtc"):
        options["block_webrtc"] = True
    if args.get("window"):
        options["window"] = tuple(args["window"])
    proxy = parse_proxy(args.get("proxy"))
    if proxy:
        options["proxy"] = proxy
        options["geoip"] = options.get("geoip", True)
    user_data_dir = args.get("user_data_dir")
    if user_data_dir:
        options["persistent_context"] = True
        options["user_data_dir"] = os.path.abspath(os.path.expanduser(user_data_dir))
    S.cm = AsyncCamoufox(**options)
    handle = await S.cm.__aenter__()
    if user_data_dir:
        S.context = handle
    else:
        S.browser = handle
        S.context = await handle.new_context(ignore_https_errors=True)
    S.context.set_default_timeout(30000)
    S.context.on("request", on_request)
    S.context.on("response", on_response)
    S.context.on("requestfinished", on_finished)
    S.context.on("requestfailed", on_failed)
    S.context.on("page", register_page)
    for page in S.context.pages:
        if page not in S.tab_of:
            register_page(page)
    if not S.context.pages:
        await S.context.new_page()


def page_or_fail(args=None):
    tab = (args or {}).get("tab_id") or S.current
    page = S.pages.get(tab)
    if page is None:
        raise RuntimeError("no open tab; use goto or new_tab first")
    return page


def timeout_of(args):
    value = args.get("timeout_ms")
    return value if value else 30000


def locate(page, args):
    selector = args.get("selector")
    if not selector:
        raise RuntimeError("selector is required")
    return page.locator(selector).first


async def page_header(page):
    try:
        title = await page.title()
    except Exception:
        title = ""
    return "url: %s\ntitle: %s" % (page.url, title)


async def cmd_open(args):
    if S.context is not None:
        return {"text": "browser already running (headless=%s). Use close first to relaunch with different options." % S.headless}
    await ensure(args)
    return {"text": "browser started (headless=%s), network recording on" % S.headless}


async def cmd_close(args):
    if S.cm is not None:
        try:
            await S.cm.__aexit__(None, None, None)
        except Exception:
            pass
    S.cm = None
    S.browser = None
    S.context = None
    S.pages.clear()
    S.tab_of.clear()
    S.current = None
    return {"text": "browser closed"}


async def cmd_goto(args):
    await ensure()
    url = args.get("url")
    if not url:
        raise RuntimeError("url is required")
    if not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", url):
        url = "https://" + url
    page = page_or_fail(args)
    response = await page.goto(url, wait_until=args.get("wait_until") or "domcontentloaded", timeout=timeout_of(args))
    status = response.status if response else "n/a"
    return {"text": "status: %s\n%s" % (status, await page_header(page))}


async def cmd_back(args):
    page = page_or_fail(args)
    await page.go_back(timeout=timeout_of(args))
    return {"text": await page_header(page)}


async def cmd_forward(args):
    page = page_or_fail(args)
    await page.go_forward(timeout=timeout_of(args))
    return {"text": await page_header(page)}


async def cmd_reload(args):
    page = page_or_fail(args)
    await page.reload(timeout=timeout_of(args))
    return {"text": await page_header(page)}


async def cmd_click(args):
    page = page_or_fail(args)
    locator = locate(page, args)
    await locator.click(
        button=args.get("button") or "left",
        click_count=2 if args.get("double") else 1,
        timeout=timeout_of(args),
    )
    return {"text": "clicked %s\n%s" % (args["selector"], await page_header(page))}


async def cmd_fill(args):
    page = page_or_fail(args)
    await locate(page, args).fill(args.get("value") or "", timeout=timeout_of(args))
    return {"text": "filled %s" % args["selector"]}


async def cmd_type(args):
    page = page_or_fail(args)
    await locate(page, args).press_sequentially(args.get("value") or "", delay=args.get("delay_ms") or 40, timeout=timeout_of(args))
    return {"text": "typed into %s" % args["selector"]}


async def cmd_press(args):
    page = page_or_fail(args)
    key = args.get("key")
    if not key:
        raise RuntimeError("key is required")
    if args.get("selector"):
        await locate(page, args).press(key, timeout=timeout_of(args))
    else:
        await page.keyboard.press(key)
    return {"text": "pressed %s\n%s" % (key, await page_header(page))}


async def cmd_select(args):
    page = page_or_fail(args)
    chosen = await locate(page, args).select_option(args.get("value") or "", timeout=timeout_of(args))
    return {"text": "selected %s" % chosen}


async def cmd_check(args):
    page = page_or_fail(args)
    await locate(page, args).check(timeout=timeout_of(args))
    return {"text": "checked %s" % args["selector"]}


async def cmd_uncheck(args):
    page = page_or_fail(args)
    await locate(page, args).uncheck(timeout=timeout_of(args))
    return {"text": "unchecked %s" % args["selector"]}


async def cmd_hover(args):
    page = page_or_fail(args)
    await locate(page, args).hover(timeout=timeout_of(args))
    return {"text": "hovering %s" % args["selector"]}


async def cmd_scroll(args):
    page = page_or_fail(args)
    if args.get("selector"):
        await locate(page, args).scroll_into_view_if_needed(timeout=timeout_of(args))
        return {"text": "scrolled %s into view" % args["selector"]}
    target = args.get("value") or "bottom"
    if target == "top":
        await page.evaluate("window.scrollTo(0, 0)")
    elif target == "bottom":
        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    else:
        await page.evaluate("window.scrollBy(0, %d)" % int(target))
    return {"text": "scrolled %s" % target}


async def cmd_upload(args):
    page = page_or_fail(args)
    paths = args.get("paths") or ([args["value"]] if args.get("value") else [])
    await locate(page, args).set_input_files([os.path.abspath(os.path.expanduser(p)) for p in paths], timeout=timeout_of(args))
    return {"text": "uploaded %d file(s)" % len(paths)}


async def cmd_wait(args):
    page = page_or_fail(args)
    timeout = timeout_of(args)
    done = []
    if args.get("selector"):
        await page.locator(args["selector"]).first.wait_for(state=args.get("state") or "visible", timeout=timeout)
        done.append("selector %s" % args["selector"])
    if args.get("url_contains"):
        needle = args["url_contains"]
        await page.wait_for_url(lambda u: needle in u, timeout=timeout)
        done.append("url contains %s" % needle)
    if args.get("text"):
        await page.get_by_text(args["text"]).first.wait_for(timeout=timeout)
        done.append("text %s" % args["text"])
    if args.get("network_idle"):
        await page.wait_for_load_state("networkidle", timeout=timeout)
        done.append("network idle")
    if args.get("ms"):
        await asyncio.sleep(args["ms"] / 1000.0)
        done.append("%dms" % args["ms"])
    if not done:
        await page.wait_for_load_state("load", timeout=timeout)
        done.append("load")
    return {"text": "waited for %s\n%s" % (", ".join(done), await page_header(page))}


async def cmd_eval(args):
    page = page_or_fail(args)
    script = args.get("script")
    if not script:
        raise RuntimeError("script is required")
    result = await page.evaluate(script)
    return {"text": json.dumps(result, indent=2, default=str) if not isinstance(result, str) else result}


async def cmd_text(args):
    page = page_or_fail(args)
    selector = args.get("selector") or "body"
    text = await page.locator(selector).first.inner_text(timeout=timeout_of(args))
    return {"text": "%s\n\n%s" % (await page_header(page), text)}


async def cmd_html(args):
    page = page_or_fail(args)
    if args.get("selector"):
        html = await page.locator(args["selector"]).first.evaluate("el => el.outerHTML")
    else:
        html = await page.content()
    return {"text": html}


async def cmd_snapshot(args):
    page = page_or_fail(args)
    selector = args.get("selector") or "body"
    tree = await page.locator(selector).first.aria_snapshot(timeout=timeout_of(args))
    return {"text": "%s\n\n%s" % (await page_header(page), tree)}


async def cmd_screenshot(args):
    page = page_or_fail(args)
    path = args.get("path") or os.path.join(tempfile.gettempdir(), "codeify-browser-%d.png" % int(time.time() * 1000))
    path = os.path.abspath(os.path.expanduser(path))
    if args.get("selector"):
        await locate(page, args).screenshot(path=path, timeout=timeout_of(args))
    else:
        await page.screenshot(path=path, full_page=bool(args.get("full_page")), timeout=timeout_of(args))
    return {"text": "screenshot saved to %s" % path, "file": path}


async def cmd_tabs(args):
    await ensure()
    lines = []
    for tab, page in S.pages.items():
        marker = "*" if tab == S.current else " "
        try:
            title = await page.title()
        except Exception:
            title = ""
        lines.append("%s tab %d  %s  %s" % (marker, tab, page.url, title))
    return {"text": "\n".join(lines) or "no tabs"}


async def cmd_new_tab(args):
    await ensure()
    page = await S.context.new_page()
    if args.get("url"):
        await page.goto(args["url"], wait_until=args.get("wait_until") or "domcontentloaded", timeout=timeout_of(args))
    return {"text": "opened tab %d\n%s" % (S.tab_of[page], await page_header(page))}


async def cmd_switch_tab(args):
    tab = args.get("tab_id")
    if tab not in S.pages:
        raise RuntimeError("unknown tab %s" % tab)
    S.current = tab
    await S.pages[tab].bring_to_front()
    return {"text": "switched to tab %d\n%s" % (tab, await page_header(S.pages[tab]))}


async def cmd_close_tab(args):
    page = page_or_fail(args)
    tab = S.tab_of.get(page)
    await page.close()
    return {"text": "closed tab %s" % tab}


def format_cookie(cookie):
    flags = []
    if cookie.get("httpOnly"):
        flags.append("httpOnly")
    if cookie.get("secure"):
        flags.append("secure")
    return "%s=%s  domain=%s path=%s %s" % (cookie["name"], clip(cookie["value"], 200), cookie.get("domain"), cookie.get("path"), " ".join(flags))


async def cmd_cookies(args):
    await ensure()
    urls = [args["url"]] if args.get("url") else None
    cookies = await S.context.cookies(urls)
    return {"text": "\n".join(format_cookie(c) for c in cookies) or "no cookies"}


async def cmd_set_cookies(args):
    await ensure()
    await S.context.add_cookies(args.get("cookies") or [])
    return {"text": "set %d cookie(s)" % len(args.get("cookies") or [])}


async def cmd_clear_cookies(args):
    await ensure()
    await S.context.clear_cookies()
    return {"text": "cookies cleared"}


def status_matches(status, wanted):
    if wanted is None:
        return True
    if status is None:
        return False
    text = str(wanted).lower()
    if re.fullmatch(r"[1-5]xx", text):
        return str(status).startswith(text[0])
    return str(status) == text


def is_api_entry(entry):
    if entry["type"] in API_TYPES:
        return True
    mime = (entry["mime"] or "").lower()
    return entry["type"] == "document" and entry["navigation"] is False and ("json" in mime or "graphql" in mime)


def select_entries(args):
    needle = args.get("url_contains")
    regex = re.compile(args["url_regex"]) if args.get("url_regex") else None
    method = (args.get("method") or "").upper()
    types = set(args.get("types") or [])
    excluded = args.get("exclude") or []
    body_needle = args.get("body_contains")
    since = args.get("since_id") or 0
    tab = args.get("tab_id")
    out = []
    for entry in S.log:
        if entry["id"] <= since:
            continue
        if needle and needle not in entry["url"]:
            continue
        if regex and not regex.search(entry["url"]):
            continue
        if method and entry["method"] != method:
            continue
        if types and entry["type"] not in types:
            continue
        if args.get("api_only") and not is_api_entry(entry):
            continue
        if not status_matches(entry["status"], args.get("status")):
            continue
        if tab and entry["tab"] != tab:
            continue
        if any(item in entry["url"] for item in excluded):
            continue
        if body_needle:
            haystack = (entry["body"] or "") + (entry["post"] or "")
            if body_needle not in haystack:
                continue
        out.append(entry)
    return out


def summarize(entry):
    size = ""
    if entry["post"]:
        size = " post=%dB" % len(entry["post"])
    if entry["body_size"] is not None:
        size += " resp=%dB" % entry["body_size"]
    elif entry["ws_frames"] is not None:
        size += " frames=%d" % len(entry["ws_frames"])
    status = entry["status"] if entry["status"] is not None else ("FAILED" if entry["failure"] else "...")
    duration = " %dms" % entry["duration"] if entry["duration"] is not None else ""
    mime = (entry["mime"] or "").split(";")[0]
    tag = " [%s]" % entry["tag"] if entry["tag"] else ""
    return "#%d %s %s %s%s %s%s%s %s" % (entry["id"], entry["method"], status, entry["type"], duration, mime, size, tag, clip(entry["url"], 300))


async def cmd_network(args):
    entries = select_entries(args)
    limit = args.get("limit") or 60
    total = len(entries)
    shown = entries[-limit:]
    header = "%d matching request(s) of %d recorded" % (total, len(S.log))
    if total > len(shown):
        header += ", showing last %d (use since_id or filters to narrow)" % len(shown)
    return {"text": header + "\n" + "\n".join(summarize(e) for e in shown)}


def pretty(text, mime):
    if text is None:
        return None
    if "json" in (mime or "").lower() or (text[:1] in "{[" and text[-1:] in "}]"):
        try:
            return json.dumps(json.loads(text), indent=2, ensure_ascii=False)
        except Exception:
            return text
    return text


def build_curl(entry):
    parts = ["curl", "-i", "-X", entry["method"], shell_quote(entry["url"])]
    for name, value in (entry["request_headers"] or {}).items():
        if name.lower() in NOISE_HEADERS or name.startswith(":"):
            continue
        parts.extend(["-H", shell_quote("%s: %s" % (name, value))])
    if entry["post"]:
        parts.extend(["--data-raw", shell_quote(entry["post"])])
    return " ".join(parts)


def shell_quote(value):
    return "'" + str(value).replace("'", "'\\''") + "'"


async def cmd_request(args):
    wanted = args.get("id")
    entry = next((e for e in S.log if e["id"] == wanted), None)
    if entry is None:
        raise RuntimeError("no recorded request with id %s" % wanted)
    max_body = args.get("max_body") or 20000
    lines = [summarize(entry), ""]
    if entry["redirected_from"]:
        lines.append("redirected from: %s" % entry["redirected_from"])
    lines.append("request headers:")
    for name, value in (entry["request_headers"] or {}).items():
        lines.append("  %s: %s" % (name, clip(value, HEADER_VALUE_LIMIT)))
    if entry["post"]:
        lines.extend(["", "request body:", clip(pretty(entry["post"], entry["request_headers"].get("content-type")), max_body)])
    if entry["response_headers"]:
        lines.extend(["", "response headers:"])
        for name, value in entry["response_headers"].items():
            lines.append("  %s: %s" % (name, clip(value, HEADER_VALUE_LIMIT)))
    if entry["failure"]:
        lines.extend(["", "failure: %s" % entry["failure"]])
    if entry["ws_frames"] is not None:
        lines.extend(["", "websocket frames (%d):" % len(entry["ws_frames"])])
        for frame in entry["ws_frames"][: args.get("limit") or 50]:
            lines.append("  %s %s" % (frame["dir"], frame["data"]))
    if entry["body"] is not None:
        body = pretty(entry["body"], entry["mime"])
        if args.get("save_to"):
            target = os.path.abspath(os.path.expanduser(args["save_to"]))
            with open(target, "w", encoding="utf-8") as handle:
                handle.write(body)
            lines.extend(["", "response body saved to %s (%d chars)" % (target, len(body))])
        else:
            lines.extend(["", "response body%s:" % (" (truncated at capture)" if entry["body_truncated"] else ""), clip(body, max_body)])
    if args.get("as_curl"):
        lines.extend(["", "curl:", build_curl(entry)])
    return {"text": "\n".join(lines)}


async def cmd_clear_network(args):
    count = len(S.log)
    S.log.clear()
    S.pending.clear()
    return {"text": "cleared %d recorded request(s)" % count}


async def cmd_export_network(args):
    entries = select_entries(args)
    target = args.get("path") or os.path.join(tempfile.gettempdir(), "codeify-network-%d.json" % int(time.time() * 1000))
    target = os.path.abspath(os.path.expanduser(target))
    with open(target, "w", encoding="utf-8") as handle:
        json.dump(entries, handle, indent=2, ensure_ascii=False, default=str)
    return {"text": "exported %d request(s) to %s" % (len(entries), target)}


async def cmd_recording(args):
    S.recording = bool(args.get("enabled", True))
    return {"text": "network recording %s" % ("on" if S.recording else "off")}


async def cmd_fetch(args):
    await ensure()
    url = args.get("url")
    if not url:
        raise RuntimeError("url is required")
    method = (args.get("method") or "GET").upper()
    headers = args.get("headers") or {}
    response = await S.context.request.fetch(
        url,
        method=method,
        headers=headers,
        data=args.get("body"),
        timeout=timeout_of(args),
        max_redirects=args.get("max_redirects") if args.get("max_redirects") is not None else 20,
    )
    data = await response.body()
    mime = response.headers.get("content-type", "")
    body = decode(data[:MAX_BODY])
    entry = {
        "id": next(S.seq),
        "t": int(time.time() * 1000),
        "tab": None,
        "method": method,
        "url": url,
        "type": "fetch",
        "navigation": False,
        "request_headers": headers,
        "post": args.get("body"),
        "status": response.status,
        "status_text": response.status_text,
        "response_headers": dict(response.headers),
        "mime": mime,
        "body": body if is_text_mime(mime) or not mime else None,
        "body_size": len(data),
        "body_truncated": len(data) > MAX_BODY,
        "duration": None,
        "failure": None,
        "redirected_from": None,
        "ws_frames": None,
        "tag": "replay",
    }
    S.log.append(entry)
    trim_log()
    max_body = args.get("max_body") or 20000
    lines = ["status: %d %s" % (response.status, response.status_text), "recorded as request #%d" % entry["id"], "", "response headers:"]
    for name, value in response.headers.items():
        lines.append("  %s: %s" % (name, clip(value, HEADER_VALUE_LIMIT)))
    if entry["body"] is not None:
        lines.extend(["", "response body:", clip(pretty(entry["body"], mime), max_body)])
    else:
        lines.extend(["", "binary response, %d bytes" % len(data)])
    return {"text": "\n".join(lines)}


COMMANDS = {
    "open": cmd_open,
    "close": cmd_close,
    "goto": cmd_goto,
    "back": cmd_back,
    "forward": cmd_forward,
    "reload": cmd_reload,
    "click": cmd_click,
    "fill": cmd_fill,
    "type": cmd_type,
    "press": cmd_press,
    "select": cmd_select,
    "check": cmd_check,
    "uncheck": cmd_uncheck,
    "hover": cmd_hover,
    "scroll": cmd_scroll,
    "upload": cmd_upload,
    "wait": cmd_wait,
    "eval": cmd_eval,
    "text": cmd_text,
    "html": cmd_html,
    "snapshot": cmd_snapshot,
    "screenshot": cmd_screenshot,
    "tabs": cmd_tabs,
    "new_tab": cmd_new_tab,
    "switch_tab": cmd_switch_tab,
    "close_tab": cmd_close_tab,
    "cookies": cmd_cookies,
    "set_cookies": cmd_set_cookies,
    "clear_cookies": cmd_clear_cookies,
    "network": cmd_network,
    "request": cmd_request,
    "clear_network": cmd_clear_network,
    "export_network": cmd_export_network,
    "recording": cmd_recording,
    "fetch": cmd_fetch,
}

AUTO_START = {
    "goto", "back", "forward", "reload", "click", "fill", "type", "press", "select", "check", "uncheck", "hover",
    "scroll", "upload", "wait", "eval", "text", "html", "snapshot", "screenshot", "new_tab", "cookies",
}

LOCK = asyncio.Lock()


async def handle(message):
    request_id = message.get("id")
    command = message.get("cmd")
    args = message.get("args") or {}
    try:
        handler = COMMANDS.get(command)
        if handler is None:
            raise RuntimeError("unknown command %s" % command)
        async with LOCK:
            if command in AUTO_START:
                await ensure(args)
            result = await handler(args)
        send({"id": request_id, "ok": True, "result": result})
    except Exception as exc:
        text = "%s: %s" % (type(exc).__name__, exc)
        send({"id": request_id, "ok": False, "error": clip(text, 3000)})


async def main():
    loop = asyncio.get_running_loop()
    send({"event": "ready"})
    tasks = set()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except Exception:
            continue
        task = asyncio.create_task(handle(message))
        tasks.add(task)
        task.add_done_callback(tasks.discard)
    await cmd_close({})


asyncio.run(main())
`;
