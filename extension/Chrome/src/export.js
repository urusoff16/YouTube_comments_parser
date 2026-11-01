const CSV_COLUMNS = [
  "comment_id",
  "parent_comment_id",
  "author",
  "author_channel_id",
  "text",
  "published_at_text",
  "published_at_timestamp",
  "likes",
  "reply_count",
  "is_reply",
  "hearted_by_creator",
  "avatar_url",
  "paid",
];

const NOTEBOOK_LABELS = {
  ru: {
    title: "КОММЕНТАРИИ YOUTUBE",
    video: "Видео",
    total: "Всего записей",
    comments: "Основных комментариев",
    replies: "Ответов",
    unknownAuthor: "Неизвестный автор",
    date: "Дата",
    dateMissing: "не указана",
    likes: "Лайки",
    link: "Ссылка",
    text: "Текст",
    threadReplies: "Ответы",
    parentAuthor: "автор основного комментария",
    orphans: "ОТВЕТЫ, РОДИТЕЛЬСКИЙ КОММЕНТАРИЙ КОТОРЫХ НЕ ПОПАЛ В ВЫГРУЗКУ",
    parentId: "Родительский ID",
    unknown: "неизвестен",
  },
  en: {
    title: "YOUTUBE COMMENTS",
    video: "Video",
    total: "Total records",
    comments: "Top-level comments",
    replies: "Replies",
    unknownAuthor: "Unknown author",
    date: "Date",
    dateMissing: "unavailable",
    likes: "Likes",
    link: "Link",
    text: "Text",
    threadReplies: "Replies",
    parentAuthor: "the parent comment author",
    orphans: "REPLIES WHOSE PARENT COMMENT IS NOT INCLUDED IN THIS EXPORT",
    parentId: "Parent ID",
    unknown: "unknown",
  },
};

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function commentUrl(videoId, commentId) {
  const url = new URL("https://www.youtube.com/watch");
  url.searchParams.set("v", videoId);
  url.searchParams.set("lc", commentId);
  return url.toString();
}

export function replyTarget(reply, parent, threadComments = [], fallback = "автор основного комментария") {
  const mention = reply.text?.trimStart().match(/^(@[^\s,.:;!?]+)/u)?.[1];
  if (mention) {
    const normalizedMention = mention.toLocaleLowerCase();
    const participant = [parent, ...threadComments]
      .find((comment) => comment?.author?.toLocaleLowerCase() === normalizedMention);
    return participant?.author ?? mention;
  }
  return parent?.author ?? fallback;
}

export function replyDisplayDepth(reply, parent, priorEntries = [], maxDepth = 3) {
  const target = replyTarget(
    reply,
    parent,
    priorEntries.map((entry) => entry.comment ?? entry),
  );
  const normalizedTarget = target?.toLocaleLowerCase();
  for (let index = priorEntries.length - 1; index >= 0; index -= 1) {
    const entry = priorEntries[index];
    const comment = entry.comment ?? entry;
    if (comment?.author?.toLocaleLowerCase() !== normalizedTarget) continue;
    return Math.min(Math.max(1, Number(entry.depth ?? 1) + 1), maxDepth);
  }
  return 1;
}

export function buildCommentThreads(comments) {
  const threads = [];
  const byId = new Map();
  for (const comment of comments) {
    if (comment.is_reply) continue;
    const thread = { comment, replies: [] };
    threads.push(thread);
    byId.set(comment.comment_id, thread);
  }

  const orphanReplies = [];
  for (const comment of comments) {
    if (!comment.is_reply) continue;
    const parentId = comment.parent_comment_id
      || (comment.comment_id?.includes(".") ? comment.comment_id.split(".", 1)[0] : null);
    const thread = byId.get(parentId);
    if (thread) thread.replies.push(comment);
    else orphanReplies.push({ ...comment, parent_comment_id: parentId });
  }
  return { threads, orphanReplies };
}

function notebookTextBlock(text, indent) {
  const normalized = String(text ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  return normalized.split("\n").map((line) => `${indent}${line}`).join("\r\n");
}

function notebookComment(comment, videoId, number, labels) {
  return [
    `[${number}] ${comment.author || labels.unknownAuthor}`,
    `    ${labels.date}: ${comment.published_at_text || labels.dateMissing}`,
    `    ${labels.likes}: ${comment.likes || "0"}`,
    `    ${labels.link}: ${commentUrl(videoId, comment.comment_id)}`,
    `    ${labels.text}:`,
    notebookTextBlock(comment.text, "      "),
  ];
}

export function serializeNotebook(comments, videoId, language = "ru") {
  const labels = NOTEBOOK_LABELS[language] ?? NOTEBOOK_LABELS.en;
  const { threads, orphanReplies } = buildCommentThreads(comments);
  const lines = [
    labels.title,
    `${labels.video}: https://www.youtube.com/watch?v=${videoId}`,
    `${labels.total}: ${comments.length}`,
    `${labels.comments}: ${threads.length}`,
    `${labels.replies}: ${comments.filter((comment) => comment.is_reply).length}`,
    "=".repeat(88),
    "",
  ];

  threads.forEach((thread, threadIndex) => {
    lines.push(...notebookComment(thread.comment, videoId, threadIndex + 1, labels));
    if (thread.replies.length) {
      lines.push(`    ${labels.threadReplies} (${thread.replies.length}):`);
      thread.replies.forEach((reply, replyIndex) => {
        const target = replyTarget(reply, thread.comment, thread.replies, labels.parentAuthor);
        lines.push(
          `      |-- [${threadIndex + 1}.${replyIndex + 1}] ${reply.author || labels.unknownAuthor} -> ${target}`,
          `      |   ${labels.date}: ${reply.published_at_text || labels.dateMissing}`,
          `      |   ${labels.likes}: ${reply.likes || "0"}`,
          `      |   ${labels.link}: ${commentUrl(videoId, reply.comment_id)}`,
          `      |   ${labels.text}:`,
          notebookTextBlock(reply.text, "      |     "),
        );
      });
    }
    lines.push("", "-".repeat(88), "");
  });

  if (orphanReplies.length) {
    lines.push(labels.orphans, "");
    orphanReplies.forEach((reply, index) => {
      lines.push(
        `[R${index + 1}] ${reply.author || labels.unknownAuthor}`,
        `    ${labels.parentId}: ${reply.parent_comment_id || labels.unknown}`,
        `    ${labels.link}: ${commentUrl(videoId, reply.comment_id)}`,
        `    ${labels.text}:`,
        notebookTextBlock(reply.text, "      "),
        "",
      );
    });
  }
  return `\uFEFF${lines.join("\r\n")}`;
}

export function serializeComments(comments, format, { videoId = "video", language = "ru" } = {}) {
  if (format === "txt") return serializeNotebook(comments, videoId, language);
  if (format === "jsonl") {
    return `${comments.map((comment) => JSON.stringify(comment)).join("\n")}\n`;
  }
  if (format === "csv") {
    const rows = comments.map((comment) => CSV_COLUMNS.map((column) => csvCell(comment[column])).join(","));
    return `\uFEFF${CSV_COLUMNS.join(",")}\r\n${rows.join("\r\n")}\r\n`;
  }
  return `${JSON.stringify(comments, null, 2)}\n`;
}

export function exportMimeType(format) {
  if (format === "txt") return "text/plain;charset=utf-8";
  if (format === "csv") return "text/csv;charset=utf-8";
  if (format === "jsonl") return "application/x-ndjson;charset=utf-8";
  return "application/json;charset=utf-8";
}

export async function downloadComments(comments, { format, videoId }) {
  const content = serializeComments(comments, format, { videoId });
  const blob = new Blob([content], { type: exportMimeType(format) });
  const url = URL.createObjectURL(blob);
  try {
    return await chrome.downloads.download({
      url,
      filename: `${videoId}_comments.${format}`,
      saveAs: true,
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

function bufferedParts() {
  const parts = [];
  let buffer = "";
  return {
    push(value) {
      buffer += value;
      if (buffer.length >= 256 * 1024) {
        parts.push(buffer);
        buffer = "";
      }
    },
    finish() {
      if (buffer) parts.push(buffer);
      return parts;
    },
  };
}

function indentedJson(value) {
  return JSON.stringify(value, null, 2).split("\n").map((line) => `  ${line}`).join("\n");
}

export async function createDatabaseExportBlob(database, {
  format,
  videoId,
  language = "en",
  forEach,
  readAll,
}) {
  let count = 0;
  let blob;
  if (format === "txt") {
    const comments = await readAll(database);
    count = comments.length;
    blob = new Blob([serializeNotebook(comments, videoId, language)], { type: exportMimeType(format) });
  } else {
    const output = bufferedParts();
    if (format === "csv") output.push(`\uFEFF${CSV_COLUMNS.join(",")}\r\n`);
    if (format === "json") output.push("[\n");
    count = await forEach(database, (comment, index) => {
      if (format === "jsonl") output.push(`${JSON.stringify(comment)}\n`);
      else if (format === "csv") output.push(`${CSV_COLUMNS.map((column) => csvCell(comment[column])).join(",")}\r\n`);
      else output.push(`${index ? ",\n" : ""}${indentedJson(comment)}`);
    });
    if (format === "json") output.push("\n]\n");
    blob = new Blob(output.finish(), { type: exportMimeType(format) });
  }

  return { blob, count };
}

export async function downloadCommentsFromDatabase(database, options) {
  const { format, videoId } = options;
  const { blob, count } = await createDatabaseExportBlob(database, options);
  const url = URL.createObjectURL(blob);
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename: `${videoId}_comments.${format}`,
      saveAs: true,
    });
    return { downloadId, count };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
