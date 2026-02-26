#!/usr/bin/env python3
"""
MFLIX Scraper Proxy — Cloudflare Bypass
=======================================
Ye server cloudscraper library use karta hai jo Cloudflare ko bypass kar sakta hai.
Tumhara Next.js app is server se HTML mangega instead of direct fetch.

Install: pip install cloudscraper flask
Run:     python scraper_proxy.py
PM2:     pm2 start scraper_proxy.py --name scraper-proxy --interpreter python3
"""

import cloudscraper
from flask import Flask, request, jsonify
import time
import random
import logging

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s [PROXY] %(message)s')
logger = logging.getLogger(__name__)

app = Flask(__name__)

# Persistent scraper session (reuses Cloudflare cookies)
scraper = cloudscraper.create_scraper(
    browser={
        'browser': 'chrome',
        'platform': 'android',
        'mobile': True,
    },
    delay=3
)

USER_AGENTS = [
    "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
]

REFERERS = [
    "https://www.google.com/",
    "https://www.google.co.in/",
    "https://www.bing.com/",
    "https://duckduckgo.com/",
]


@app.route('/fetch', methods=['GET'])
def fetch_page():
    """Fetch a page using cloudscraper and return raw HTML"""
    url = request.args.get('url')
    if not url:
        return jsonify({"status": "error", "message": "url parameter required"}), 400

    try:
        # Rotate headers for each request
        scraper.headers.update({
            "User-Agent": random.choice(USER_AGENTS),
            "Referer": random.choice(REFERERS),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9,hi;q=0.8",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "cross-site",
            "Upgrade-Insecure-Requests": "1",
        })

        # Small random delay to look human
        delay = random.uniform(0.5, 2.0)
        time.sleep(delay)

        logger.info(f"Fetching: {url}")
        response = scraper.get(url, timeout=20, allow_redirects=True)
        logger.info(f"Got {response.status_code} for: {url} (length: {len(response.text)})")

        # Check for Cloudflare challenge indicators
        is_cf_challenge = any(marker in response.text for marker in [
            'cf-challenge',
            'Just a moment...',
            'Checking your browser',
            'cf-turnstile',
            'challenges.cloudflare.com',
        ])

        if is_cf_challenge:
            logger.warning(f"Cloudflare challenge detected for: {url}")
            # Try once more with fresh session
            scraper2 = cloudscraper.create_scraper(
                browser={'browser': 'chrome', 'platform': 'windows', 'desktop': True},
                delay=5
            )
            time.sleep(random.uniform(2, 4))
            response = scraper2.get(url, timeout=25, allow_redirects=True)
            logger.info(f"Retry got {response.status_code} (length: {len(response.text)})")

        return jsonify({
            "status": "success",
            "html": response.text,
            "status_code": response.status_code,
            "url": response.url,
            "content_length": len(response.text),
        })

    except cloudscraper.exceptions.CloudflareChallengeError as e:
        logger.error(f"Cloudflare challenge failed for {url}: {e}")
        return jsonify({
            "status": "error",
            "message": f"Cloudflare challenge failed: {str(e)}"
        }), 503

    except Exception as e:
        logger.error(f"Error fetching {url}: {e}")
        return jsonify({
            "status": "error",
            "message": str(e)
        }), 500


@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        "status": "ok",
        "service": "mflix-scraper-proxy",
        "port": 5001
    })


if __name__ == '__main__':
    logger.info("🚀 MFLIX Scraper Proxy starting on port 5001")
    app.run(host='0.0.0.0', port=5001, debug=False)
