import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import youtube_comments_parser as parser


class FakeDownloader:
    def __init__(self, comments):
        self.comments = comments
        self.call = None

    def get_comments_from_url(self, url, **kwargs):
        self.call = (url, kwargs)
        yield from self.comments


class ParserTests(unittest.TestCase):
    def test_video_id_from_supported_urls(self):
        self.assertEqual(parser.video_id_from_url("https://youtu.be/abcdefghijk"), "abcdefghijk")
        self.assertEqual(
            parser.video_id_from_url("https://www.youtube.com/watch?v=abcdefghijk&t=3"),
            "abcdefghijk",
        )
        self.assertEqual(
            parser.video_id_from_url("https://www.youtube.com/shorts/abcdefghijk"),
            "abcdefghijk",
        )

    def test_download_writes_normalized_json_and_honors_limit(self):
        comments = [
            {
                "cid": f"id-{index}",
                "author": "Автор",
                "channel": "channel-id",
                "text": f"Текст {index}",
                "time": "1 day ago",
                "time_parsed": 123.0,
                "votes": "1.2K",
                "replies": 2,
                "reply": False,
                "heart": True,
                "photo": "https://example.test/avatar.jpg",
            }
            for index in range(3)
        ]
        fake = FakeDownloader(comments)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "comments.json"
            with patch.object(parser, "create_downloader", return_value=fake):
                count = parser.download_comments(
                    "https://youtu.be/abcdefghijk", output, limit=2, language="ru", delay=0.5
                )

            self.assertEqual(count, 2)
            data = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual([item["comment_id"] for item in data], ["id-0", "id-1"])
            self.assertEqual(data[0]["likes"], "1.2K")
            self.assertEqual(fake.call[1]["language"], "ru")
            self.assertEqual(fake.call[1]["sleep"], 0.5)

    def test_existing_file_is_not_overwritten_without_force(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "comments.json"
            output.write_text("keep", encoding="utf-8")
            with self.assertRaises(FileExistsError):
                parser.download_comments("https://youtu.be/abcdefghijk", output)
            self.assertEqual(output.read_text(encoding="utf-8"), "keep")

    def test_partial_file_is_removed_on_generator_error(self):
        def broken_comments():
            yield {"cid": "first", "text": "ok"}
            raise RuntimeError("network failed")

        fake = FakeDownloader(broken_comments())
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "comments.json"
            with patch.object(parser, "create_downloader", return_value=fake):
                with self.assertRaisesRegex(RuntimeError, "network failed"):
                    parser.download_comments("https://youtu.be/abcdefghijk", output)
            self.assertFalse(output.exists())
            self.assertEqual(list(Path(directory).glob("*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
