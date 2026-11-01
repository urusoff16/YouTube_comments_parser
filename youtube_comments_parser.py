"""Download publicly available YouTube comments without a Data API key."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import parse_qs, urlparse


SORT_BY_POPULAR = 0
SORT_BY_RECENT = 1
SUPPORTED_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "www.youtube-nocookie.com",
}


def positive_int(value: str) -> int:
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("значение должно быть больше нуля")
    return number


def non_negative_float(value: str) -> float:
    number = float(value)
    if number < 0:
        raise argparse.ArgumentTypeError("значение не может быть отрицательным")
    return number


def youtube_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in SUPPORTED_HOSTS:
        raise argparse.ArgumentTypeError("нужна полная ссылка на видео YouTube")
    return value


def video_id_from_url(url: str) -> str | None:
    parsed = urlparse(url)
    if parsed.hostname == "youtu.be":
        candidate = parsed.path.strip("/").split("/", 1)[0]
    else:
        candidate = parse_qs(parsed.query).get("v", [None])[0]
        if candidate is None:
            parts = [part for part in parsed.path.split("/") if part]
            candidate = parts[1] if len(parts) >= 2 and parts[0] in {"shorts", "live", "embed"} else None
    return candidate if candidate and re.fullmatch(r"[A-Za-z0-9_-]{6,}", candidate) else None


def default_output_path(url: str) -> Path:
    video_id = video_id_from_url(url)
    return Path(f"{video_id or 'youtube'}_comments.json")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Выгружает доступные комментарии и ответы YouTube в JSON без ключа Data API."
    )
    parser.add_argument("url", type=youtube_url, help="полная ссылка на видео YouTube")
    parser.add_argument("-o", "--output", type=Path, help="путь к итоговому JSON-файлу")
    parser.add_argument(
        "--sort",
        choices=("popular", "recent"),
        default="popular",
        help="порядок комментариев: popular (по умолчанию) или recent",
    )
    parser.add_argument("--limit", type=positive_int, help="остановиться после указанного числа комментариев")
    parser.add_argument("--language", help="язык служебного текста YouTube, например ru или en")
    parser.add_argument(
        "--delay",
        type=non_negative_float,
        default=0.1,
        help="пауза между страницами в секундах (по умолчанию: 0.1)",
    )
    parser.add_argument("--force", action="store_true", help="перезаписать существующий файл")
    return parser


def create_downloader() -> Any:
    try:
        from youtube_comment_downloader import YoutubeCommentDownloader
    except ImportError as error:
        raise RuntimeError(
            "Библиотека не установлена. Выполните: python -m pip install -r requirements.txt"
        ) from error
    return YoutubeCommentDownloader()


def normalize_comment(comment: dict[str, Any]) -> dict[str, Any]:
    """Return a stable, lossless-enough schema for downstream processing."""
    result = {
        "comment_id": comment.get("cid"),
        "author": comment.get("author"),
        "author_channel_id": comment.get("channel"),
        "text": comment.get("text"),
        "published_at_text": comment.get("time"),
        "published_at_timestamp": comment.get("time_parsed"),
        # YouTube may return abbreviated/localized values such as "1.2K", so this
        # field intentionally remains a string instead of being coerced to int.
        "likes": comment.get("votes", "0"),
        "reply_count": comment.get("replies", 0),
        "is_reply": bool(comment.get("reply", False)),
        "hearted_by_creator": bool(comment.get("heart", False)),
        "avatar_url": comment.get("photo"),
    }
    if "paid" in comment:
        result["paid"] = comment["paid"]
    return result


def limited(comments: Iterable[dict[str, Any]], limit: int | None) -> Iterable[dict[str, Any]]:
    for index, comment in enumerate(comments):
        if limit is not None and index >= limit:
            return
        yield comment


def download_comments(
    url: str,
    output_path: Path,
    *,
    sort: str = "popular",
    limit: int | None = None,
    language: str | None = None,
    delay: float = 0.1,
    force: bool = False,
) -> int:
    output_path = output_path.resolve()
    if output_path.exists() and not force:
        raise FileExistsError(f"Файл уже существует: {output_path}. Добавьте --force для перезаписи.")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = output_path.with_name(f".{output_path.name}.{os.getpid()}.tmp")
    downloader = create_downloader()
    sort_value = SORT_BY_POPULAR if sort == "popular" else SORT_BY_RECENT
    comments = downloader.get_comments_from_url(
        url,
        sort_by=sort_value,
        language=language,
        sleep=delay,
    )

    count = 0
    try:
        with temporary_path.open("w", encoding="utf-8", newline="\n") as output:
            output.write("[\n")
            for comment in limited(comments, limit):
                if count:
                    output.write(",\n")
                json.dump(normalize_comment(comment), output, ensure_ascii=False, indent=2)
                count += 1
                if count % 100 == 0:
                    output.flush()
                    print(f"Собрано: {count}", file=sys.stderr)
            output.write("\n]\n")
        os.replace(temporary_path, output_path)
    except BaseException:
        temporary_path.unlink(missing_ok=True)
        raise
    return count


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    output_path = args.output or default_output_path(args.url)
    print(f"Собираю комментарии в {output_path.resolve()} ...", file=sys.stderr)
    try:
        count = download_comments(
            args.url,
            output_path,
            sort=args.sort,
            limit=args.limit,
            language=args.language,
            delay=args.delay,
            force=args.force,
        )
    except KeyboardInterrupt:
        print("Остановлено пользователем; незавершенный файл удален.", file=sys.stderr)
        return 130
    except Exception as error:
        print(f"Ошибка: {error}", file=sys.stderr)
        return 1

    print(f"Готово: сохранено записей: {count}. Файл: {output_path.resolve()}", file=sys.stderr)
    if count == 0:
        print(
            "YouTube не вернул комментарии: они могут быть отключены, недоступны или временно заблокированы.",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
