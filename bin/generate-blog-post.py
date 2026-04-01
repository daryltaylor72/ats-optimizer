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
    :root{{--bg:#0a0b0f;--surface:#111318;--surface2:#181b22;--border:rgba(255,255,255,0.07);--text:#edeef5;--text2:#8892aa;--accent:#6c63ff;--accent-dim:rgba(108,99,255,0.14);--serif:'DM Serif Display',Georgia,serif;--sans:'Nunito Sans',system-ui,sans-serif}}
    [data-theme="light"]{{--bg:#ffffff;--surface:#f5f6fa;--surface2:#ecedf3;--border:rgba(0,0,0,0.08);--border2:rgba(0,0,0,0.15);--text:#1a1b2e;--text2:#5a6080;--text3:#8892aa;--accent:#5b54e0;--accent-dim:rgba(108,99,255,0.08)}}
    [data-theme="light"] body::before{{background-image:linear-gradient(rgba(108,99,255,0.035) 1px,transparent 1px),linear-gradient(90deg,rgba(108,99,255,0.035) 1px,transparent 1px)}}
    [data-theme="light"] nav{{background:rgba(255,255,255,0.85);border-bottom-color:rgba(0,0,0,0.08)}}
    [data-theme="light"] .btn-ghost{{border-color:rgba(0,0,0,0.15)}}
    [data-theme="light"] .btn-ghost:hover{{border-color:rgba(0,0,0,0.25)}}
    .theme-toggle{{cursor:pointer;font-size:16px;line-height:1;border:1px solid rgba(255,255,255,0.13);background:transparent;color:var(--text2);border-radius:8px;padding:7px 12px}}
    .theme-toggle:hover{{color:var(--text)}}
    [data-theme="light"] .theme-toggle{{border-color:rgba(0,0,0,0.15)}}
    .theme-icon-light{{display:none}}
    [data-theme="light"] .theme-icon-dark{{display:none}}
    [data-theme="light"] .theme-icon-light{{display:inline}}
    html{{scroll-behavior:smooth}}body{{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.7;margin:0}}
    body::before{{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(108,99,255,0.025) 1px,transparent 1px),linear-gradient(90deg,rgba(108,99,255,0.025) 1px,transparent 1px);background-size:48px 48px;pointer-events:none;z-index:0}}
    nav{{position:fixed;top:0;left:0;right:0;z-index:100;background:rgba(10,11,15,0.85);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);padding:16px 28px;display:flex;align-items:center;justify-content:space-between}}
    .nav-logo{{display:flex;align-items:center;gap:10px;text-decoration:none}}.nav-logo-mark{{width:32px;height:32px;background:var(--accent);border-radius:8px;display:flex;align-items:center;justify-content:center;font-family:monospace;font-size:14px;font-weight:700;color:#fff}}.nav-logo-text{{font-family:var(--serif);font-size:20px;color:var(--text)}}
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

<nav><a href="/" class="nav-logo"><div class="nav-logo-mark">A</div><span class="nav-logo-text">ATScore</span></a><div class="nav-links"><button class="btn-ghost theme-toggle" onclick="toggleTheme()" aria-label="Toggle theme"><span class="theme-icon-dark">&#9790;</span><span class="theme-icon-light">&#9728;</span></button><a href="/blog" class="btn-ghost">Blog</a><a href="/#pricing" class="btn-ghost">Pricing</a><a href="/tool" class="btn-ghost">Try Free</a></div></nav>

<div class="container">
  <header class="blog-header">
    <div class="breadcrumb"><a href="/">Home</a> / <a href="/blog">Blog</a> / {breadcrumb_label}</div>
    <h1>{h1_title}</h1>
    <div class="meta">Published {pub_date_display} &middot; {read_time} min read</div>
  </header>

  <article class="blog-content">
{article_body}
  </article>
</div>

<footer><p>&copy; 2026 ATScore. All rights reserved. &middot; <a href="/" style="color:var(--accent);text-decoration:none">atscore.ai</a></p></footer>

<script>
function toggleTheme(){{var c=document.documentElement.getAttribute('data-theme');var n=c==='light'?'dark':'light';document.documentElement.setAttribute('data-theme',n);localStorage.setItem('theme',n)}}
(function(){{var s=localStorage.getItem('theme');if(s)document.documentElement.setAttribute('data-theme',s)}})();
</script>
</body>
</html>"""

# ── Blog index card template ────────────────────────────────────────────────
INDEX_CARD = """\
      <a href="/blog/{slug}/" class="article-card">
        <div class="tag">{tag}</div>
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
    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

    primary_kw = derive_primary_keyword(topic["slug"], topic["title"])

    msg = client.messages.create(
        model="claude-sonnet-4-6",
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


def build_page(topic: dict, article_body: str, pub_date_iso: str, pub_date_display: str) -> str:
    """Assemble the full HTML page from the template."""
    slug        = topic["slug"]
    title       = topic["title"]
    description = topic["description"]
    tag         = topic["tag"]
    canonical   = f"{SITE_DOMAIN}/blog/{slug}/"
    read_time   = estimate_read_time(article_body)

    # Breadcrumb label: last meaningful word(s) from title, capped at ~40 chars
    breadcrumb_label = title if len(title) <= 40 else title[:37] + "..."

    return PAGE_TEMPLATE.format(
        page_title=title,
        meta_description=description[:155],
        canonical_url=canonical,
        site_domain=SITE_DOMAIN,
        pub_date_iso=pub_date_iso,
        pub_date_display=pub_date_display,
        breadcrumb_label=breadcrumb_label,
        h1_title=title,
        read_time=read_time,
        article_body=article_body,
    )


def update_blog_index(topic: dict) -> None:
    """Prepend the new article card to the articles section in blog/index.html."""
    index_path = BLOG_DIR / "index.html"
    content    = index_path.read_text()

    # The card description: first sentence of the topic description
    card_desc = topic["description"].split("--")[0].strip()
    if len(card_desc) > 150:
        card_desc = card_desc[:147] + "..."

    new_card = INDEX_CARD.format(
        slug=topic["slug"],
        tag=topic["tag"],
        title=topic["title"],
        card_description=card_desc,
    )

    # Insert after the opening <section class="articles"> tag
    marker = '<section class="articles">\n'
    if marker not in content:
        print("WARNING: Could not find articles section marker in blog/index.html — skipping index update")
        return

    updated = content.replace(marker, marker + "\n" + new_card, 1)
    index_path.write_text(updated)
    print(f"  Updated blog/index.html with card for '{topic['title']}'")


def git_commit_and_push(slug: str, title: str) -> None:
    """Stage the new blog post files and push to GitHub."""
    run = lambda cmd: subprocess.run(
        cmd, cwd=str(REPO_DIR), check=True, capture_output=True, text=True
    )

    # Stage the new post directory, updated index, and topics file
    run(["git", "add",
         f"public/blog/{slug}/",
         "public/blog/index.html",
         "blog-topics.json"])

    commit_msg = f"content: add blog post — {title}"
    run(["git", "commit", "-m", commit_msg])
    run(["git", "push", "origin", "main"])
    print(f"  Committed and pushed: {commit_msg}")


def main() -> None:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("ERROR: ANTHROPIC_API_KEY not set in environment")
        sys.exit(1)

    # Load topics
    with open(TOPICS_FILE) as f:
        data = json.load(f)

    # Find next unpublished topic that doesn't already have a directory (safety check)
    topic = next(
        (t for t in data["topics"]
         if not t.get("published") and not (BLOG_DIR / t["slug"]).exists()),
        None
    )
    if not topic:
        print("No unpublished topics remaining (or all pending slugs already exist on disk). Add more to blog-topics.json.")
        sys.exit(0)

    slug  = topic["slug"]
    title = topic["title"]
    print(f"Generating: {title}")

    # Dates
    now              = datetime.now()
    pub_date_iso     = now.strftime("%Y-%m-%d")
    pub_date_display = now.strftime("%B %-d, %Y")   # e.g. April 1, 2026

    # Generate article HTML via Claude
    print("  Calling Claude Sonnet...")
    article_body = generate_article_html(topic)
    print(f"  Generated {len(article_body)} characters")

    # Build full page
    page_html = build_page(topic, article_body, pub_date_iso, pub_date_display)

    # Write to disk
    post_dir = BLOG_DIR / slug
    post_dir.mkdir(parents=True, exist_ok=True)
    (post_dir / "index.html").write_text(page_html)
    print(f"  Wrote public/blog/{slug}/index.html")

    # Update blog index
    update_blog_index(topic)

    # Mark as published in topics file
    topic["published"]      = True
    topic["published_date"] = pub_date_iso
    with open(TOPICS_FILE, "w") as f:
        json.dump(data, f, indent=2)
    print("  Marked topic as published in blog-topics.json")

    # Commit and push
    print("  Committing and pushing...")
    git_commit_and_push(slug, title)

    print(f"\nDone. Live at: {SITE_DOMAIN}/blog/{slug}/")


if __name__ == "__main__":
    main()
