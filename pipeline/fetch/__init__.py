"""Downloaders for the open datasets. Every fetch is cached on disk, so a rebuild never downloads twice."""
import os
import time

import requests

USER_AGENT = "map-to-explorable-world/1.0 (+https://github.com/pranavharan02/map-to-explorable-world)"
_session = requests.Session()
_session.headers["User-Agent"] = USER_AGENT


def request(method, url, retries=4, timeout=180, backoff=2, **kw):
    """HTTP request with retries and exponential back-off for transient failures (429, 5xx, timeouts)."""
    err = None
    for k in range(retries):
        if k:
            time.sleep(backoff * 2 ** (k - 1))
        try:
            r = _session.request(method, url, timeout=timeout, **kw)
            if r.status_code in (429, 502, 503, 504):
                raise requests.HTTPError(f"{r.status_code} from {url}")
            r.raise_for_status()
            return r
        except (requests.ConnectionError, requests.Timeout, requests.HTTPError) as e:
            err = e
            if getattr(e, "response", None) is not None and e.response.status_code == 404:
                raise
    raise err


def ensure_dir(path):
    os.makedirs(path, exist_ok=True)
    return path


def gdal_env():
    """GDAL settings for fast windowed reads of cloud-optimized GeoTIFFs over HTTPS."""
    return dict(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_MULTIRANGE="YES", GDAL_HTTP_MERGE_CONSECUTIVE_RANGES="YES",
                CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif,.TIF,.tiff", GDAL_HTTP_USERAGENT=USER_AGENT, VSI_CACHE="TRUE",
                GDAL_HTTP_MAX_RETRY="4", GDAL_HTTP_RETRY_DELAY="2")
