#!/usr/bin/env python3
"""
ATScore Blog Post Generator
-----------------------------
Picks the next unpublished topic from blog-topics.json, generates a full
HTML blog post via Claude Sonnet, writes it to the site, updates the blog
index, then commits and pushes to GitHub.

Run: python3 bin/generate-blog-post.py
Requires: ANTHROPIC_API_KEY in environment
"""

import json
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import anthropic

# ── Paths ─────────────────────────────────────────────────────────────────
REPO_DIR    = Path(__file__).parent.parent.resolve()
TOPICS_FILE = REPO_DIR / "blog-topics.json"
BLOG_DIR    = REPO_DIR / "public" / "blog"
SITE_DOMAIN = "https://atscore.ai"

# ── HTML shell template ────────────────────────────────────────────────────
PAGE_TEMPLATE = """\
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon.png">
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
  <script>(function(){{var mq=window.matchMedia("(prefers-color-scheme: light)");var theme=mq.matches?"light":"dark";document.documentElement.setAttribute("data-theme",theme);document.documentElement.style.colorScheme=theme;}})();</script>
  <title>{page_title} | ATScore Blog</title>
  <meta name="description" content="{meta_description}">
  <link rel="canonical" href="{canonical_url}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="{canonical_url}">
  <meta property="og:title" content="{page_title}">
  <meta property="og:description" content="{meta_description}">
  <meta property="og:site_name" content="ATScore">
  <meta name="twitter:card" content="summary_large_image">
  <meta property="og:image" content="{site_domain}/og-image.png">
  <meta name="twitter:image" content="{site_domain}/og-image.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Nunito+Sans:opsz,wght@6..12,300;6..12,400;6..12,500;6..12,600;6..12,700&display=swap" rel="stylesheet">
  <script type="application/ld+json">
  {{
    "@context": "https://schema.org", "@type": "Article",
    "headline": "{page_title}",
    "description": "{meta_description}",
    "author": {{"@type": "Organization", "name": "ATScore"}},
    "publisher": {{"@type": "Organization", "name": "ATScore", "url": "{site_domain}"}},
    "datePublished": "{pub_date_iso}",
    "url": "{canonical_url}"
  }}
  </script>
  <style>
    :root{{color-scheme:dark;--bg:#0a0b0f;--surface:#111318;--surface2:#181b22;--border:rgba(255,255,255,0.07);--border2:rgba(255,255,255,0.13);--text:#edeef5;--text2:#8892aa;--text3:#484f68;--accent:#6c63ff;--accent-dim:rgba(108,99,255,0.14);--serif:'DM Serif Display',Georgia,serif;--sans:'Nunito Sans',system-ui,sans-serif}}
    [data-theme="light"]{{color-scheme:light;--bg:#ffffff;--surface:#f5f6fa;--surface2:#ecedf3;--border:rgba(0,0,0,0.08);--border2:rgba(0,0,0,0.15);--text:#1a1b2e;--text2:#5a6080;--text3:#8892aa;--accent:#5b54e0;--accent-dim:rgba(108,99,255,0.08)}}
    [data-theme="light"] body::before{{background-image:linear-gradient(rgba(108,99,255,0.035) 1px,transparent 1px),linear-gradient(90deg,rgba(108,99,255,0.035) 1px,transparent 1px)}}
    [data-theme="light"] nav{{background:rgba(255,255,255,0.85);border-bottom-color:rgba(0,0,0,0.08)}}
    [data-theme="light"] .btn-ghost{{border-color:rgba(0,0,0,0.15)}}
    [data-theme="light"] .btn-ghost:hover{{border-color:rgba(0,0,0,0.25)}}
    html{{scroll-behavior:smooth}}body{{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.7;margin:0}}
    body::before{{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(108,99,255,0.025) 1px,transparent 1px),linear-gradient(90deg,rgba(108,99,255,0.025) 1px,transparent 1px);background-size:48px 48px;pointer-events:none;z-index:0}}
    nav{{position:fixed;top:0;left:0;right:0;z-index:100;background:rgba(10,11,15,0.85);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);padding:16px 28px;display:flex;align-items:center;justify-content:space-between}}
    .nav-logo{{display:flex;align-items:center;gap:10px;text-decoration:none}}.nav-logo-mark{{width:90px;height:90px;border-radius:8px;object-fit:contain}}.nav-logo-text{{font-family:var(--serif);font-size:20px;color:var(--text)}}
    .nav-links{{display:flex;gap:8px}}.btn-ghost{{font-size:13px;font-weight:600;color:var(--text2);background:transparent;border:1px solid rgba(255,255,255,0.13);border-radius:8px;padding:8px 16px;text-decoration:none;transition:0.2s}}.btn-ghost:hover{{color:var(--text);border-color:rgba(255,255,255,0.25)}}
    .container{{max-width:760px;margin:0 auto;padding:0 28px;position:relative;z-index:1}}
    .blog-header{{padding:140px 0 40px}}.blog-header .breadcrumb{{font-size:13px;color:var(--text2);margin-bottom:16px}}.blog-header .breadcrumb a{{color:var(--accent);text-decoration:none}}
    .blog-header h1{{font-family:var(--serif);font-size:clamp(32px,4vw,48px);line-height:1.15;margin-bottom:16px}}.blog-header .meta{{font-size:14px;color:var(--text2)}}
    .blog-content h2{{font-family:var(--serif);font-size:28px;margin:48px 0 16px;color:var(--text)}}.blog-content h3{{font-size:20px;font-weight:700;margin:32px 0 12px}}
    .blog-content p{{color:var(--text2);margin-bottom:20px;font-size:16px}}.blog-content ul,.blog-content ol{{color:var(--text2);margin-bottom:20px;padding-left:24px}}.blog-content li{{margin-bottom:8px}}.blog-content strong{{color:var(--text)}}.blog-content a{{color:var(--accent);text-decoration:none}}.blog-content a:hover{{text-decoration:underline}}
    .cta-box{{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:40px;text-align:center;margin:48px 0}}.cta-box h3{{font-family:var(--serif);font-size:24px;margin-bottom:12px;color:var(--text)}}.cta-box p{{color:var(--text2);margin-bottom:20px}}
    .cta-btn{{display:inline-block;background:var(--accent);color:#fff;font-weight:700;padding:14px 32px;border-radius:10px;text-decoration:none;font-size:15px}}.cta-btn:hover{{filter:brightness(1.1)}}
    .blog-content .cta-btn{{color:#fff}}
    .checklist-box{{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:28px 32px;margin:24px 0}}.checklist-box h4{{font-size:17px;font-weight:700;color:var(--text);margin:0 0 14px}}.checklist-box ul{{list-style:none;padding:0;margin:0}}.checklist-box li{{padding:6px 0;color:var(--text2);font-size:15px}}.checklist-box li::before{{content:'\\2713';color:var(--accent);font-weight:700;margin-right:10px}}
    footer{{border-top:1px solid var(--border);padding:32px 28px;text-align:center;color:var(--text2);font-size:13px;margin-top:80px}}
  </style>
</head>
<body>

<nav><a href="/" class="nav-logo"><img src="/logo-128.png" alt="ATScore logo" class="nav-logo-mark"><span class="nav-logo-text">ATScore</span></a><div class="nav-links"><a href="/blog/" class="btn-ghost">Blog</a><a href="/#pricing" class="btn-ghost">Pricing</a><a href="/tool/" class="btn-ghost">Try Free</a></div></nav>

<div class="container">
  <header class="blog-header">
    <div class="breadcrumb"><a href="/">Home</a> / <a href="/blog/">Blog</a> / {breadcrumb_label}</div>
    <h1>{h1_title}</h1>
    <div class="meta">Published {pub_date_display} &middot; {read_time} min read &middot; By ATScore</div>
  </header>

  <article class="blog-content">
{article_body}
  </article>
</div>

<footer><p>&copy; 2026 ATScore by <a href="https://deeptierlabs.app" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline;">DeepTier Labs</a>. All rights reserved. &middot; <a href="/privacy/" style="color:var(--accent);text-decoration:none">Privacy</a> &middot; <a href="/terms/" style="color:var(--accent);text-decoration:none">Terms</a> &middot; <a href="mailto:support@atscore.ai" style="color:var(--accent);text-decoration:none">support@atscore.ai</a></p></footer>

<script>
(function(){{var media=window.matchMedia("(prefers-color-scheme: light)");function applyTheme(event){{var isLight=typeof event==="boolean" ? event : event.matches;var theme=isLight?"light":"dark";document.documentElement.setAttribute("data-theme",theme);document.documentElement.style.colorScheme=theme}}applyTheme(media.matches);if(typeof media.addEventListener==="function"){{media.addEventListener("change",applyTheme)}}else if(typeof media.addListener==="function"){{media.addListener(applyTheme)}}}})();
</script>
</body>
</html>"""

# ── Blog index card template ────────────────────────────────────────────────
INDEX_CARD = """\
      <a href="/blog/{slug}/" class="article-card">
        <div class="meta">
          <div class="tag">{tag}</div>
          <div class="date">{pub_date_display}</div>
        </div>
        <h2>{title}</h2>
        <p>{card_description}</p>
        <span class="read-more">Read article &rarr;</span>
      </a>

"""

# ── Generation prompt ───────────────────────────────────────────────────────
ARTICLE_SYSTEM = """You are an expert SEO content writer specialising in resume writing, ATS systems, and career advice. You write for ATScore (atscore.ai), an AI-powered ATS resume checker and optimizer.

Your job is to write a high-quality, SEO-optimised blog article body in HTML. Follow these rules exactly:

1. Write 1000-1300 words of article body content.
2. Use ONLY these HTML elements: <p>, <h2>, <h3>, <ul>, <ol>, <li>, <strong>, <a href="/tool">, <div class="cta-box">, <div class="checklist-box">, <table>, <thead>, <tbody>, <tr>, <th>, <td>.
3. Include exactly ONE mid-article CTA box using this structure:
   <div class="cta-box">
     <h3>[Relevant CTA heading]</h3>
     <p>[One sentence benefit]</p>
     <a href="/tool" class="cta-btn">Scan Your Resume Free</a>
   </div>
4. Include at least one <div class="checklist-box"> with a <h4> title and a <ul> of concrete tips.
5. End with a closing h2 section ("Final Thoughts" or similar), then a final cta-box pointing to /tool.
6. Do NOT include <html>, <head>, <body>, <style>, <script>, <nav>, <footer>, or any wrapper tags — article body only.
7. Use "atscore.ai" or "ATScore" for internal references, never "DeepTier Labs".
8. Write confidently, with specific facts and examples. No filler or repetitive phrases.
9. The opening paragraph must hook the reader immediately — no generic "In today's job market..." intros.
10. Use em dashes (--) not em-dash unicode. Use straight quotes."""

ARTICLE_USER = """Write the full article body HTML for a blog post with this brief:

Title: {title}
Description: {description}
Tag/Category: {tag}

Target keyword to use naturally throughout: {primary_keyword}

Existing ATScore blog posts you can link to internally (use <a href="/blog/slug/"> when relevant):
- /blog/how-to-pass-ats-screening/ — How to Pass ATS Screening in 2026
- /blog/ats-resume-format-guide/ — ATS Resume Format: The Complete Guide
- /blog/why-resume-rejected-by-ats/ — Why Your Resume Gets Rejected by ATS
- /blog/ats-keywords-by-industry/ — ATS Keywords by Industry
- /blog/what-is-good-ats-score/ — What Is a Good ATS Score?
- /blog/resume-action-verbs/ — 150+ Resume Action Verbs That Get Past ATS
- /blog/ats-resume-career-change/ — ATS-Friendly Resume for Career Changers
- /blog/how-to-tailor-resume-for-each-job/ — How to Tailor Your Resume for Each Job
- /blog/ats-friendly-resume-template/ — ATS-Friendly Resume Template
- /blog/resume-skills-section-ats/ — How to Write the Skills Section for ATS
- /blog/ats-resume-summary-examples/ — ATS-Friendly Resume Summary Examples
- /blog/employment-gap-resume-ats/ — How to Handle Employment Gaps on an ATS Resume

Output ONLY the raw article body HTML — no explanation, no markdown fences, no wrapper tags."""


def estimate_read_time(html_body: str) -> int:
    """Estimate read time in minutes from HTML content (200 wpm)."""
    text = re.sub(r"<[^>]+>", " ", html_body)
    words = len(text.split())
    return max(1, round(words / 200))


def derive_primary_keyword(slug: str, title: str) -> str:
    """Extract the likely primary keyword from the slug."""
    return slug.replace("-", " ")


def generate_article_html(topic: dict) -> str:
    """Call Claude Sonnet to generate the article body HTML."""
    base_url = os.environ.get("ANTHROPIC_BASE_URL")
    if base_url:
        # Anthropic SDK expects the base URL without the /v1 suffix (it adds it)
        if base_url.endswith("/v1"):
            base_url = base_url[:-3]
        client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"], base_url=base_url)
    else:
        client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

    primary_kw = derive_primary_keyword(topic["slug"], topic["title"])

    msg = client.messages.create(
        model="anthropic/claude-sonnet-4.6",
        max_tokens=4096,
        system=ARTICLE_SYSTEM,
        messages=[{
            "role": "user",
            "content": ARTICLE_USER.format(
                title=topic["title"],
                description=topic["description"],
                tag=topic["tag"],
                primary_keyword=primary_kw,
            )
        }]
    )
    return msg.content[0].text.strip()
