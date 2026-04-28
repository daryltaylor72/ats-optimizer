import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "bin" / "generate-blog-post.py"


def load_generator():
    spec = importlib.util.spec_from_file_location("generate_blog_post", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class BlogGeneratorTests(unittest.TestCase):
    def test_generator_exposes_publish_pipeline_functions(self):
        generator = load_generator()
        for name in ["build_page", "update_blog_index", "git_commit_and_push", "main"]:
            self.assertTrue(hasattr(generator, name), f"missing {name}")

    def test_main_can_generate_next_unpublished_post_without_git_or_api(self):
        generator = load_generator()
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            blog_dir = repo / "public" / "blog"
            blog_dir.mkdir(parents=True)
            (blog_dir / "index.html").write_text(
                '<section class="articles">\n</section>\n',
                encoding="utf-8",
            )
            topics_file = repo / "blog-topics.json"
            topics_file.write_text(json.dumps({"topics": [
                {
                    "slug": "already-published",
                    "title": "Already Published",
                    "description": "Existing description.",
                    "tag": "Guide",
                    "published": True,
                    "published_date": "2026-04-01",
                },
                {
                    "slug": "new-topic",
                    "title": "New Topic",
                    "description": "New description for the card.",
                    "tag": "Strategy",
                    "published": False,
                    "published_date": None,
                },
            ]}, indent=2), encoding="utf-8")

            generator.REPO_DIR = repo
            generator.TOPICS_FILE = topics_file
            generator.BLOG_DIR = blog_dir
            generator.generate_article_html = lambda topic: (
                "<p>Opening paragraph.</p>"
                "<div class=\"cta-box\"><h3>CTA</h3><p>Benefit.</p>"
                "<a href=\"/tool\" class=\"cta-btn\">Scan Your Resume Free</a></div>"
                "<h2>Final Thoughts</h2><p>Done.</p>"
            )

            exit_code = generator.main(["--no-git", "--date", "2026-04-28"])

            self.assertEqual(exit_code, 0)
            self.assertTrue((blog_dir / "new-topic" / "index.html").exists())
            updated_topics = json.loads(topics_file.read_text(encoding="utf-8"))["topics"]
            self.assertTrue(updated_topics[1]["published"])
            self.assertEqual(updated_topics[1]["published_date"], "2026-04-28")
            index_html = (blog_dir / "index.html").read_text(encoding="utf-8")
            self.assertIn('/blog/new-topic/', index_html)
            self.assertIn('New Topic', index_html)


if __name__ == "__main__":
    unittest.main()
