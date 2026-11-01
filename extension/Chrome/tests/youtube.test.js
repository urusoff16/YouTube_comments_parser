import test from "node:test";
import assert from "node:assert/strict";

import {
  extractBalancedJson,
  extractInitialData,
  extractPageConfiguration,
  extractVideoId,
  nextEndpoints,
  normalizeYoutubeUrl,
  parseComments,
  postYoutubeReply,
  replyCommandsFromResponse,
} from "../src/youtube.js";
import {
  buildCommentThreads,
  commentUrl,
  createDatabaseExportBlob,
  replyDisplayDepth,
  replyTarget,
  serializeComments,
  serializeNotebook,
} from "../src/export.js";
import { nextTheme, normalizeTheme } from "../src/theme.js";
import { normalizeLanguagePreference, resolveLanguage, translatorFor } from "../src/i18n.js";

test("поддерживает обычные, короткие и Shorts-ссылки", () => {
  assert.equal(extractVideoId("https://www.youtube.com/watch?v=8_DfIWtDY8o&t=3"), "8_DfIWtDY8o");
  assert.equal(extractVideoId("https://youtu.be/8_DfIWtDY8o"), "8_DfIWtDY8o");
  assert.equal(extractVideoId("https://www.youtube.com/shorts/8_DfIWtDY8o"), "8_DfIWtDY8o");
  assert.equal(normalizeYoutubeUrl("https://youtu.be/8_DfIWtDY8o"), "https://www.youtube.com/watch?v=8_DfIWtDY8o");
  assert.throws(() => extractVideoId("https://example.com/watch?v=8_DfIWtDY8o"), /YouTube/);
});

test("извлекает сбалансированный JSON со скобками в строках", () => {
  const source = String.raw`prefix {"text":"}\"still text", "nested":{"ok":true}} suffix`;
  assert.deepEqual(JSON.parse(extractBalancedJson(source, 0)), {
    text: '}"still text',
    nested: { ok: true },
  });
});

test("объединяет ytcfg и извлекает ytInitialData", () => {
  const html = `
    <script>ytcfg.set({"INNERTUBE_API_KEY":"key"});</script>
    <script>ytcfg.set({"INNERTUBE_CONTEXT":{"client":{"clientName":"WEB"}}});</script>
    <script>var ytInitialData = {"contents":{"ok":true}};</script>`;
  assert.equal(extractPageConfiguration(html).INNERTUBE_API_KEY, "key");
  assert.deepEqual(extractInitialData(html), { contents: { ok: true } });
});

test("нормализует новый формат commentEntityPayload", () => {
  const response = {
    frameworkUpdates: {
      entityBatchUpdate: {
        mutations: [
          { payload: { engagementToolbarStateEntityPayload: { key: "toolbar-1", heartState: "TOOLBAR_HEART_STATE_HEARTED" } } },
          {
            payload: {
              commentEntityPayload: {
                properties: {
                  commentId: "parent.reply",
                  content: { content: "Текст ответа" },
                  publishedTime: "1 день назад",
                  toolbarStateKey: "toolbar-1",
                },
                author: { displayName: "Автор", channelId: "channel", avatarThumbnailUrl: "avatar" },
                toolbar: { likeCountNotliked: "1,2 тыс.", replyCount: 0 },
              },
            },
          },
        ],
      },
    },
  };
  assert.deepEqual(parseComments(response), [{
    comment_id: "parent.reply",
    parent_comment_id: "parent",
    author: "Автор",
    author_channel_id: "channel",
    text: "Текст ответа",
    published_at_text: "1 день назад",
    published_at_timestamp: null,
    likes: "1,2 тыс.",
    reply_count: 0,
    is_reply: true,
    hearted_by_creator: true,
    avatar_url: "avatar",
  }]);
});

test("находит continuation для следующей страницы", () => {
  const endpoint = {
    commandMetadata: { webCommandMetadata: { apiUrl: "/youtubei/v1/next" } },
    continuationCommand: { token: "next-token" },
  };
  const response = {
    onResponseReceivedEndpoints: [{
      appendContinuationItemsAction: {
        targetId: "comments-section",
        continuationItems: [{ continuationItemRenderer: { continuationEndpoint: endpoint } }],
      },
    }],
  };
  assert.deepEqual(nextEndpoints(response), [endpoint]);
});

test("связывает действие ответа с нужным комментарием", () => {
  const response = {
    commentViewModel: {
      commentId: "parent",
      replyButton: {
        commandMetadata: { webCommandMetadata: { apiUrl: "/youtubei/v1/comment/create_comment_reply" } },
        createCommentReplyEndpoint: { createReplyParams: "signed-params" },
      },
    },
  };
  assert.deepEqual(replyCommandsFromResponse(response).get("parent"), {
    api_path: "/youtubei/v1/comment/create_comment_reply",
    create_reply_params: "signed-params",
  });
});

test("находит актуальную reply-команду через toolbarSurfaceKey", () => {
  const response = {
    onResponseReceivedEndpoints: [{
      appendContinuationItemsAction: {
        continuationItems: [{
          commentViewModel: {
            commentViewModel: {
              commentId: "parent-new",
              toolbarSurfaceKey: "toolbar-surface-parent-new",
            },
          },
        }],
      },
    }],
    frameworkUpdates: {
      entityBatchUpdate: {
        mutations: [{
          entityKey: "toolbar-surface-parent-new",
          payload: {
            engagementToolbarSurfaceEntityPayload: {
              replyCommand: {
                innertubeCommand: {
                  commandMetadata: {
                    webCommandMetadata: { apiUrl: "/youtubei/v1/comment/create_comment_reply" },
                  },
                  createCommentReplyEndpoint: { createReplyParams: "fresh-signed-params" },
                },
              },
            },
          },
        }],
      },
    },
  };
  assert.deepEqual(replyCommandsFromResponse(response).get("parent-new"), {
    api_path: "/youtubei/v1/comment/create_comment_reply",
    create_reply_params: "fresh-signed-params",
  });
});

test("отправляет один подтвержденный пользователем ответ без автоматических повторов", async () => {
  const requests = [];
  const result = await postYoutubeReply({
    command: {
      api_path: "/youtubei/v1/comment/create_comment_reply",
      create_reply_params: "signed-params",
    },
    configuration: {
      INNERTUBE_API_KEY: "key",
      INNERTUBE_CONTEXT: { client: { clientName: "WEB" } },
      INNERTUBE_CONTEXT_CLIENT_NAME: 1,
      INNERTUBE_CONTEXT_CLIENT_VERSION: "1.0",
    },
    text: "  Спасибо за ответ  ",
    async fetchImpl(url, init) {
      requests.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        async json() { return { actionResult: { status: "STATUS_SUCCEEDED" } }; },
      };
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].url).searchParams.get("key"), "key");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    context: { client: { clientName: "WEB" } },
    createReplyParams: "signed-params",
    commentText: "Спасибо за ответ",
  });
  assert.deepEqual(result.comments, []);
});

test("не повторяет запрос публикации после ошибки сервера", async () => {
  let calls = 0;
  await assert.rejects(() => postYoutubeReply({
    command: { create_reply_params: "params" },
    configuration: { INNERTUBE_API_KEY: "key", INNERTUBE_CONTEXT: { client: {} } },
    text: "Ответ",
    async fetchImpl() {
      calls += 1;
      return { ok: false, status: 500 };
    },
  }), (error) => error.code === "replyRejectedHttp");
  assert.equal(calls, 1);
});

test("экспортирует JSONL и экранирует CSV", () => {
  const comments = [{ comment_id: "id", author: "A, B", text: 'строка "один"\nдва' }];
  assert.equal(JSON.parse(serializeComments(comments, "jsonl").trim()).comment_id, "id");
  const csv = serializeComments(comments, "csv");
  assert.match(csv, /"A, B"/);
  assert.match(csv, /"строка ""один""\nдва"/);
});

test("строит ветки и TXT-схему для Блокнота", () => {
  const comments = [
    {
      comment_id: "parent",
      parent_comment_id: null,
      author: "@parent",
      text: "Основной текст",
      published_at_text: "вчера",
      likes: "10",
      is_reply: false,
    },
    {
      comment_id: "parent.reply-1",
      author: "@first",
      text: "Первый ответ",
      published_at_text: "сегодня",
      likes: "2",
      is_reply: true,
    },
    {
      comment_id: "parent.reply-2",
      parent_comment_id: "parent",
      author: "@second",
      text: "@first отвечаю вам",
      published_at_text: "сегодня",
      likes: "0",
      is_reply: true,
    },
  ];

  const hierarchy = buildCommentThreads(comments);
  assert.equal(hierarchy.threads.length, 1);
  assert.equal(hierarchy.threads[0].replies.length, 2);
  assert.equal(hierarchy.orphanReplies.length, 0);
  assert.equal(replyTarget(comments[2], comments[0], comments), "@first");
  assert.equal(replyDisplayDepth(comments[1], comments[0], []), 1);
  assert.equal(replyDisplayDepth(comments[2], comments[0], [{ comment: comments[1], depth: 1 }]), 2);

  const notebook = serializeNotebook(comments, "video-id");
  assert.match(notebook, /\[1\] @parent/);
  assert.match(notebook, /\[1\.1\] @first -> @parent/);
  assert.match(notebook, /\[1\.2\] @second -> @first/);
  assert.match(notebook, /Основной текст/);
  assert.match(notebook, /lc=parent\.reply-2/);
  assert.equal(serializeComments(comments, "txt", { videoId: "video-id" }), notebook);
});

test("создает прямую ссылку на конкретный комментарий", () => {
  const url = new URL(commentUrl("video-id", "parent.reply"));
  assert.equal(url.searchParams.get("v"), "video-id");
  assert.equal(url.searchParams.get("lc"), "parent.reply");
});

test("переключает светлую и тёмную темы с безопасной тёмной по умолчанию", () => {
  assert.equal(normalizeTheme("light"), "light");
  assert.equal(normalizeTheme("unknown"), "dark");
  assert.equal(nextTheme("dark"), "light");
  assert.equal(nextTheme("light"), "dark");
});

test("выбирает язык автоматически или по явной настройке", () => {
  assert.equal(normalizeLanguagePreference("unknown"), "auto");
  assert.equal(resolveLanguage("auto", "ru-RU"), "ru");
  assert.equal(resolveLanguage("auto", "en-US"), "en");
  assert.equal(resolveLanguage("en", "ru-RU"), "en");
  assert.equal(translatorFor("en")("status.progress", { total: 10, queued: 2 }), "Collected 10. Requests queued: 2.");
});

test("создает английскую TXT-иерархию", () => {
  const comments = [{
    comment_id: "parent",
    author: "@author",
    text: "Hello",
    is_reply: false,
    likes: "1",
  }];
  const notebook = serializeNotebook(comments, "video-id", "en");
  assert.match(notebook, /YOUTUBE COMMENTS/);
  assert.match(notebook, /Total records: 1/);
  assert.match(notebook, /Text:/);
});

test("формирует большой JSON курсором без массива readAll", async () => {
  const records = [
    { comment_id: "one", text: "First" },
    { comment_id: "two", text: "Second" },
  ];
  let readAllCalled = false;
  const { blob, count } = await createDatabaseExportBlob({}, {
    format: "json",
    videoId: "video-id",
    async forEach(_database, callback) {
      records.forEach(callback);
      return records.length;
    },
    async readAll() {
      readAllCalled = true;
      return records;
    },
  });
  assert.equal(count, 2);
  assert.equal(readAllCalled, false);
  assert.deepEqual(JSON.parse(await blob.text()), records);
});
