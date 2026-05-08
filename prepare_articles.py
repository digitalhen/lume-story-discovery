#!/usr/bin/env python3
"""Flatten the paginated Reuters export into a slim articles.json for the browser POC."""
import json
import sys
from pathlib import Path

SRC = Path(__file__).parent / "henry-en.2026-04-16.json"
DST = Path(__file__).parent / "articles.json"


def parse_stream(text: str):
    decoder = json.JSONDecoder()
    idx = 0
    while idx < len(text):
        while idx < len(text) and text[idx].isspace():
            idx += 1
        if idx >= len(text):
            break
        obj, end = decoder.raw_decode(text, idx)
        yield obj
        idx = end


def extract_body(story: dict) -> str:
    parts = []
    for el in story.get("content_elements", []) or []:
        if el.get("type") == "text" and el.get("content"):
            parts.append(el["content"])
    return "\n\n".join(parts)


def image_url(story: dict) -> str:
    promo = (story.get("promo_items") or {}).get("basic") or {}
    if promo.get("type") == "image" and promo.get("url"):
        return promo["url"]
    return ""


def byline(story: dict) -> str:
    by = (story.get("credits") or {}).get("by") or []
    names = [b.get("name") for b in by if b.get("name")]
    return ", ".join(names)


def main():
    text = SRC.read_text()
    stories = []
    for page in parse_stream(text):
        stories.extend(page.get("content_elements", []))

    out = []
    for s in stories:
        if s.get("type") != "story":
            continue
        out.append({
            "id": s.get("_id"),
            "headline": (s.get("headlines") or {}).get("basic", ""),
            "description": (s.get("description") or {}).get("basic", ""),
            "body": extract_body(s),
            "section": ((s.get("taxonomy") or {}).get("primary_section") or {}).get("name", ""),
            "date": s.get("display_date") or s.get("first_publish_date", ""),
            "url": s.get("canonical_url") or s.get("website_url", ""),
            "byline": byline(s),
            "image_url": image_url(s),
        })

    DST.write_text(json.dumps(out, ensure_ascii=False))
    size_mb = DST.stat().st_size / (1024 * 1024)
    print(f"wrote {len(out)} articles to {DST.name} ({size_mb:.1f} MB)", file=sys.stderr)


if __name__ == "__main__":
    main()
