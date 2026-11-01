import { extensionError } from "./errors.js";

const DATABASE_NAME = "youtube-comments-exporter";
const DATABASE_VERSION = 2;
const LEGACY = "comments";
const COMMENTS = "videoComments";
const VIDEOS = "videos";
const DRAFTS = "drafts";
const SENT = "sentReplies";

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", resolve, { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error || new Error("Transaction aborted")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error), { once: true });
  });
}

function connection(database) { return database.connection ?? database; }
function publicComment({ sequence, video_id, ...comment }) { return comment; }
function scopeRange(videoId, start = 0) { return IDBKeyRange.bound([videoId, start], [videoId, Number.MAX_SAFE_INTEGER]); }
function newVideo(videoId) {
  return { video_id: videoId, url: "https://www.youtube.com/watch?v=" + videoId, total: 0, replies: 0, next_sequence: 0, updated_at: Date.now(), status: "saved" };
}

export async function openCommentDatabase(videoId = null) {
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  request.addEventListener("upgradeneeded", () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(LEGACY)) {
      const store = db.createObjectStore(LEGACY, { keyPath: "comment_id" });
      store.createIndex("sequence", "sequence", { unique: true });
    }
    const comments = db.createObjectStore(COMMENTS, { keyPath: ["video_id", "comment_id"] });
    comments.createIndex("videoSequence", ["video_id", "sequence"], { unique: true });
    db.createObjectStore(VIDEOS, { keyPath: "video_id" });
    for (const [name, keyPath] of [[DRAFTS, ["video_id", "comment_id", "channel_id"]], [SENT, ["video_id", "comment_id"]]]) {
      const store = db.createObjectStore(name, { keyPath });
      store.createIndex("video", "video_id");
    }
  });
  return new Promise((resolve, reject) => {
    let blocked = false;
    request.addEventListener("blocked", () => {
      blocked = true;
      reject(extensionError("databaseBlocked", "Закройте старые страницы расширения и откройте его заново для обновления базы."));
    });
    request.addEventListener("error", () => reject(request.error), { once: true });
    request.addEventListener("success", () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.addEventListener("versionchange", () => db.close());
      resolve({ connection: db, videoId, close() { db.close(); } });
    }, { once: true });
  });
}

export async function listVideoDatasets(database) {
  const tx = connection(database).transaction(VIDEOS, "readonly");
  const done = transactionDone(tx);
  const result = await requestResult(tx.objectStore(VIDEOS).getAll());
  await done;
  return result.sort((a, b) => b.updated_at - a.updated_at);
}

export async function getVideoDataset(database) {
  if (!database.videoId) return null;
  const tx = connection(database).transaction(VIDEOS, "readonly");
  const done = transactionDone(tx);
  const result = await requestResult(tx.objectStore(VIDEOS).get(database.videoId));
  await done;
  return result ?? null;
}

export async function setDatasetState(database, status) {
  const tx = connection(database).transaction(VIDEOS, "readwrite");
  const done = transactionDone(tx);
  const store = tx.objectStore(VIDEOS);
  const request = store.get(database.videoId);
  request.addEventListener("success", () => store.put({ ...(request.result ?? newVideo(database.videoId)), status, updated_at: Date.now() }), { once: true });
  await done;
}

function deleteRange(store, range, indexName) {
  const request = (indexName ? store.index(indexName) : store).openCursor(range);
  request.addEventListener("success", () => {
    const cursor = request.result;
    if (cursor) { cursor.delete(); cursor.continue(); }
  });
}

export async function clearComments(database) {
  if (!database.videoId) {
    const tx = connection(database).transaction(LEGACY, "readwrite");
    const done = transactionDone(tx);
    tx.objectStore(LEGACY).clear();
    await done;
    return;
  }
  const tx = connection(database).transaction([COMMENTS, VIDEOS, DRAFTS, SENT], "readwrite");
  const done = transactionDone(tx);
  deleteRange(tx.objectStore(COMMENTS), scopeRange(database.videoId), "videoSequence");
  for (const name of [DRAFTS, SENT]) deleteRange(tx.objectStore(name), IDBKeyRange.only(database.videoId), "video");
  tx.objectStore(VIDEOS).delete(database.videoId);
  await done;
}

export async function storeComments(database, comments, startSequence = 0) {
  if (!database.videoId) {
    const tx = connection(database).transaction(LEGACY, "readwrite");
    const done = transactionDone(tx);
    comments.forEach((comment, offset) => tx.objectStore(LEGACY).put({ ...comment, sequence: startSequence + offset }));
    await done;
    return;
  }
  const tx = connection(database).transaction([COMMENTS, VIDEOS], "readwrite", { durability: "relaxed" });
  const done = transactionDone(tx);
  const store = tx.objectStore(COMMENTS);
  const videos = tx.objectStore(VIDEOS);
  const request = videos.get(database.videoId);
  let summary;
  request.addEventListener("success", () => {
    summary = request.result ?? newVideo(database.videoId);
    const unique = [...new Map(comments.filter((comment) => comment.comment_id).map((comment) => [comment.comment_id, comment])).values()];
    let pending = unique.length;
    if (!pending) videos.put(summary);
    for (const comment of unique) {
      const existing = store.get([database.videoId, comment.comment_id]);
      existing.addEventListener("success", () => {
        const previous = existing.result;
        const record = { ...previous, ...comment, video_id: database.videoId, sequence: previous?.sequence ?? summary.next_sequence++ };
        if (previous?.sent_by_extension) record.sent_by_extension = true;
        if (!previous) summary.total += 1;
        summary.replies += Number(Boolean(record.is_reply)) - Number(Boolean(previous?.is_reply));
        store.put(record);
        if (--pending === 0) {
          summary.updated_at = Date.now();
          videos.put(summary);
        }
      }, { once: true });
    }
  }, { once: true });
  await done;
  return summary;
}

export async function storePublishedReply(database, reply, sequence, target = {}) {
  if (!database.videoId) throw extensionError("datasetRequired", "Для ответа нужно выбрать сохранённое видео.");
  const tx = connection(database).transaction([COMMENTS, VIDEOS, DRAFTS, SENT], "readwrite");
  const done = transactionDone(tx);
  const store = tx.objectStore(COMMENTS);
  const videos = tx.objectStore(VIDEOS);
  let inserted = false;
  let summary;
  const meta = videos.get(database.videoId);
  meta.addEventListener("success", () => {
    summary = meta.result ?? newVideo(database.videoId);
    const existing = store.get([database.videoId, reply.comment_id]);
    existing.addEventListener("success", () => {
      inserted = !existing.result;
      store.put({ ...existing.result, ...reply, sent_by_extension: true, video_id: database.videoId, sequence: existing.result?.sequence ?? summary.next_sequence++ });
      if (inserted) {
        summary.total += 1;
        summary.replies += 1;
        const parent = store.get([database.videoId, reply.parent_comment_id]);
        parent.addEventListener("success", () => {
          if (parent.result) store.put({ ...parent.result, reply_count: (Number(parent.result.reply_count) || 0) + 1 });
        }, { once: true });
      }
      summary.updated_at = Date.now();
      videos.put(summary);
      tx.objectStore(SENT).put({ video_id: database.videoId, comment_id: reply.comment_id, target_comment_id: target.comment_id ?? reply.parent_comment_id, channel_id: target.channel_id ?? reply.author_channel_id, text: reply.text, published_at: Date.now() });
      if (target.comment_id && target.channel_id) tx.objectStore(DRAFTS).delete([database.videoId, target.comment_id, target.channel_id]);
    }, { once: true });
  }, { once: true });
  await done;
  return { inserted, summary };
}

async function readRows(database, start = 0, limit = Infinity) {
  if (limit <= 0) return [];
  const tx = connection(database).transaction(database.videoId ? COMMENTS : LEGACY, "readonly");
  const done = transactionDone(tx);
  const index = tx.objectStore(database.videoId ? COMMENTS : LEGACY).index(database.videoId ? "videoSequence" : "sequence");
  const request = index.openCursor(database.videoId ? scopeRange(database.videoId, Math.max(0, start)) : IDBKeyRange.lowerBound(Math.max(0, start)));
  const result = [];
  await new Promise((resolve, reject) => {
    request.addEventListener("success", () => {
      const cursor = request.result;
      if (!cursor || result.length >= limit) { resolve(); return; }
      result.push(cursor.value);
      cursor.continue();
    });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
  await done;
  return result;
}

export async function readComments(database) { return (await readRows(database)).map(publicComment); }
export async function readCommentRange(database, startSequence = 0, limit = 300) { return (await readRows(database, startSequence, limit)).map(publicComment); }

export async function forEachComment(database, callback) {
  const tx = connection(database).transaction(database.videoId ? COMMENTS : LEGACY, "readonly");
  const done = transactionDone(tx);
  const index = tx.objectStore(database.videoId ? COMMENTS : LEGACY).index(database.videoId ? "videoSequence" : "sequence");
  const request = index.openCursor(database.videoId ? scopeRange(database.videoId) : undefined);
  let count = 0;
  await new Promise((resolve, reject) => {
    request.addEventListener("success", () => {
      const cursor = request.result;
      if (!cursor) { resolve(); return; }
      try { callback(publicComment(cursor.value), count++); cursor.continue(); }
      catch (error) { tx.abort(); reject(error); }
    });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
  await done;
  return count;
}

export async function countComments(database) {
  const tx = connection(database).transaction(database.videoId ? COMMENTS : LEGACY, "readonly");
  const done = transactionDone(tx);
  const store = tx.objectStore(database.videoId ? COMMENTS : LEGACY);
  const count = await requestResult(database.videoId ? store.index("videoSequence").count(scopeRange(database.videoId)) : store.count());
  await done;
  return count;
}

export async function importLegacyComments(database) {
  if (!database.videoId) throw extensionError("datasetRequired", "Выберите видео для прежних данных.");
  const legacy = { ...database, videoId: null };
  let start = 0;
  let copied = 0;
  for (;;) {
    const rows = await readRows(legacy, start, 500);
    if (!rows.length) return copied;
    await storeComments(database, rows.map(publicComment));
    copied += rows.length;
    start = rows.at(-1).sequence + 1;
  }
}

export async function saveReplyDraft(database, draft) {
  if (!database.videoId) throw extensionError("datasetRequired", "Выберите видео для черновика.");
  const tx = connection(database).transaction([DRAFTS, VIDEOS], "readwrite");
  const done = transactionDone(tx);
  const key = [database.videoId, draft.comment_id, draft.channel_id];
  let missing = false;
  const video = tx.objectStore(VIDEOS).get(database.videoId);
  video.addEventListener("success", () => {
    if (!video.result) { missing = true; tx.abort(); return; }
    if (!draft.text && draft.state !== "uncertain") tx.objectStore(DRAFTS).delete(key);
    else tx.objectStore(DRAFTS).put({ ...draft, video_id: database.videoId, updated_at: Date.now() });
  }, { once: true });
  try { await done; }
  catch (error) {
    if (missing) throw extensionError("datasetMissing", "Набор этого видео удалён. Откройте локальные данные заново.");
    throw error;
  }
}

export async function readReplyDraft(database, commentId, channelId) {
  const tx = connection(database).transaction(DRAFTS, "readonly");
  const done = transactionDone(tx);
  const result = await requestResult(tx.objectStore(DRAFTS).get([database.videoId, commentId, channelId]));
  await done;
  return result ?? null;
}

export async function listSentReplies(database) {
  const tx = connection(database).transaction(SENT, "readonly");
  const done = transactionDone(tx);
  const result = await requestResult(tx.objectStore(SENT).index("video").getAll(database.videoId));
  await done;
  return result;
}
