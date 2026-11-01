import {
  clearComments,
  countComments,
  forEachComment,
  getVideoDataset,
  importLegacyComments,
  listVideoDatasets,
  openCommentDatabase,
  readReplyDraft,
  readCommentRange,
  readComments,
  storeComments,
  storePublishedReply,
  saveReplyDraft,
  setDatasetState,
} from "./src/database.js";
import { commentUrl, downloadCommentsFromDatabase, replyDisplayDepth, replyTarget } from "./src/export.js";
import { extensionError, localizedErrorMessage } from "./src/errors.js";
import { initializeLanguageSelect, normalizeLanguagePreference } from "./src/i18n.js";
import { createYoutubeRequester } from "./src/request-proxy.js";
import { initializeThemeToggle } from "./src/theme.js";
import { createYoutubeAccount } from "./src/youtube-account.js";
import {
  collectYoutubeComments,
  CollectorStoppedError,
  extractVideoId,
  normalizeYoutubeUrl,
} from "./src/youtube.js";

const FORMAT_LABELS = { json: "JSON", jsonl: "JSONL", csv: "CSV", txt: "TXT" };
const PREVIEW_BATCH_SIZE = 300;
const query = new URLSearchParams(location.search);
const runOptions = {
  url: query.get("url") ?? "",
  sort: query.get("sort") === "recent" ? "recent" : "popular",
  format: ["json", "jsonl", "csv", "txt"].includes(query.get("format")) ? query.get("format") : "json",
  language: normalizeLanguagePreference(query.get("language")),
  limit: Math.max(0, Number.parseInt(query.get("limit") ?? "0", 10) || 0),
  delay: Math.min(60_000, Math.max(100, Number.parseInt(query.get("delay") ?? "500", 10) || 500)),
};

const elements = {
  themeToggle: document.querySelector("#theme-toggle"),
  form: document.querySelector("#setup-form"),
  formError: document.querySelector("#form-error"),
  url: document.querySelector("#video-url"),
  sort: document.querySelector("#sort"),
  format: document.querySelector("#format"),
  limit: document.querySelector("#limit"),
  delay: document.querySelector("#delay"),
  language: document.querySelector("#language"),
  start: document.querySelector("#start-button"),
  badge: document.querySelector("#state-badge"),
  title: document.querySelector("#run-title"),
  status: document.querySelector("#status"),
  progress: document.querySelector(".progress"),
  videoLink: document.querySelector("#video-link"),
  details: document.querySelector("#run-details"),
  total: document.querySelector("#total-count"),
  comments: document.querySelector("#comment-count"),
  replies: document.querySelector("#reply-count"),
  pages: document.querySelector("#page-count"),
  elapsed: document.querySelector("#elapsed"),
  commentsList: document.querySelector("#comments-list"),
  pause: document.querySelector("#pause-button"),
  stop: document.querySelector("#stop-button"),
  download: document.querySelector("#download-button"),
  downloadTxt: document.querySelector("#txt-download-button"),
  downloadTxtLabel: document.querySelector("#txt-download-label"),
  clearData: document.querySelector("#clear-data-button"),
  previewControls: document.querySelector("#preview-controls"),
  previewSummary: document.querySelector("#preview-summary"),
  loadMore: document.querySelector("#load-more-button"),
  accountConnect: document.querySelector("#account-connect"),
  accountDisconnect: document.querySelector("#account-disconnect"),
  accountChannel: document.querySelector("#account-channel"),
  accountStatus: document.querySelector("#account-status"),
  accountExtensionId: document.querySelector("#account-extension-id"),
  savedVideos: document.querySelector("#saved-videos"),
  savedSummary: document.querySelector("#saved-summary"),
  reloadSaved: document.querySelector("#reload-saved"),
  legacyNotice: document.querySelector("#legacy-notice"),
  importLegacy: document.querySelector("#import-legacy"),
};

const abortController = new AbortController();
const threadNodes = new Map();
const pendingReplies = new Map();
const youtubeAccount = createYoutubeAccount();
const renderedCommentIds = new Set();
let languageController;
let themeController;
let database;
let requester = null;
let sequence = 0;
let renderedSequence = 0;
let previewCapacity = PREVIEW_BATCH_SIZE;
let topLevelCount = 0;
let replyCount = 0;
let paused = false;
let resumeCollector = null;
let startedAt = Date.now();
let timer = null;
let finalState = true;
let collectionFinished = false;
let orphanRepliesRendered = false;
let currentBadgeKey = "collector.ready";
let currentBadgeState = "waiting";
let activeComposer = null;
let accountBusy = false;
let accountMessage = null;
let postingReply = false;
const draftWrites = new Set();

const t = (key, values) => languageController.t(key, values);

function setBadge(key, state) {
  currentBadgeKey = key;
  currentBadgeState = state;
  elements.badge.textContent = t(key);
  elements.badge.className = `badge badge--${state}`;
}

function setStatus(text) {
  elements.status.textContent = text;
}

function setStatusKey(key, values) {
  setStatus(t(key, values));
}

function formatElapsed(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function populateForm() {
  elements.url.value = runOptions.url;
  elements.sort.value = runOptions.sort;
  elements.format.value = runOptions.format;
  elements.limit.value = runOptions.limit || "";
  elements.delay.value = String(runOptions.delay);
  elements.language.value = languageController.preference;
  updateDownloadLabel();
}

function updateDownloadLabel() {
  elements.download.textContent = t("download.button", {
    format: FORMAT_LABELS[elements.format.value] ?? t("field.format"),
  });
  elements.downloadTxtLabel.textContent = t("export.notebook");
}

function avatarInitial(author) {
  return (author || "?").replace(/^@/, "").trim().charAt(0).toUpperCase() || "?";
}

function createAvatar(comment) {
  const avatar = document.createElement("span");
  avatar.className = "avatar";
  avatar.textContent = avatarInitial(comment.author);
  if (comment.avatar_url) {
    const image = document.createElement("img");
    image.src = comment.avatar_url;
    image.alt = "";
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => image.remove(), { once: true });
    avatar.append(image);
  }
  return avatar;
}

function createYoutubeLink(comment, videoId) {
  if (!comment.comment_id) return null;
  const link = document.createElement("a");
  const author = comment.author || t("comment.unknownAuthorLower");
  link.className = "youtube-link";
  link.href = commentUrl(videoId, comment.comment_id);
  link.target = "_blank";
  link.rel = "noreferrer";
  link.title = t("comment.openTitle");
  link.setAttribute("aria-label", t("comment.openAria", { author }));
  const icon = document.createElement("span");
  icon.textContent = "▶";
  icon.setAttribute("aria-hidden", "true");
  link.append(icon);
  return link;
}

function closeActiveComposer() {
  activeComposer?.remove();
  activeComposer = null;
}

async function withVideoLock(action) {
  if (!database?.videoId) throw extensionError("datasetRequired", "Выберите видео.");
  if (!navigator.locks) throw extensionError("datasetLocks", "Браузер не поддерживает блокировку данных.");
  return navigator.locks.request(`youtube-comments-video-${database.videoId}`, { ifAvailable: true }, async (lock) => {
    if (!lock) throw extensionError("datasetBusy", "Это видео изменяется в другой вкладке. Дождитесь завершения.");
    return action();
  });
}

function applyDatasetSummary(summary) {
  sequence = summary?.total ?? 0;
  replyCount = summary?.replies ?? 0;
  topLevelCount = sequence - replyCount;
  elements.total.textContent = String(sequence);
  elements.comments.textContent = String(topLevelCount);
  elements.replies.textContent = String(replyCount);
}

async function refreshLibrary() {
  if (!database) return;
  const datasets = await listVideoDatasets(database);
  elements.savedVideos.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = t("library.choose");
  elements.savedVideos.append(placeholder);
  for (const dataset of datasets) {
    const option = document.createElement("option");
    option.value = dataset.video_id;
    option.textContent = `${dataset.video_id} · ${t("library.records", { count: dataset.total })}`;
    elements.savedVideos.append(option);
  }
  elements.savedVideos.value = database.videoId ?? "";
  elements.savedSummary.textContent = t("library.summary", { count: datasets.length });
  elements.reloadSaved.disabled = !database.videoId || !finalState || postingReply;
}

async function restoreDataset() {
  if (!database?.videoId || postingReply || !finalState) return;
  await Promise.all([...draftWrites]);
  const summary = await getVideoDataset(database);
  applyDatasetSummary(summary);
  collectionFinished = true;
  resetPreviewDom();
  const comments = await readCommentRange(database, 0, previewCapacity);
  renderComments(comments, database.videoId);
  renderedSequence = comments.length;
  maybeRenderOrphans(database.videoId);
  updatePreviewControls();
  elements.title.textContent = t("library.savedTitle");
  elements.videoLink.href = runOptions.url;
  elements.videoLink.textContent = runOptions.url;
  elements.details.textContent = t("library.retention");
  setBadge("collector.ready", "waiting");
  setStatusKey(["collecting", "partial"].includes(summary?.status) ? "library.partial" : "status.dataReady", { count: sequence });
  enableDownloads(sequence > 0);
  await refreshLibrary();
  refreshReplyButtons();
}

function refreshReplyButtons() {
  const channel = youtubeAccount.channel;
  const available = Boolean(channel && !accountBusy && !postingReply && finalState);
  elements.commentsList.querySelectorAll(".comment__reply-button").forEach((button) => {
    button.disabled = !available || !button.dataset.parentId;
    button.title = !finalState ? t("reply.waitCollection") : !channel ? t("reply.connectFirst") : "";
  });
  if (activeComposer?.dataset.state === "draft") {
    activeComposer.querySelector(".reply-composer__send").disabled = !available || activeComposer.dataset.channelId !== channel?.id;
  }
}

function refreshAccountUi() {
  const channel = youtubeAccount.channel;
  elements.accountConnect.hidden = Boolean(channel);
  elements.accountDisconnect.hidden = !channel;
  elements.accountConnect.disabled = accountBusy || postingReply;
  elements.accountDisconnect.disabled = accountBusy || postingReply;
  elements.accountConnect.textContent = t(accountBusy ? "account.connecting" : "account.connect");
  elements.accountChannel.hidden = !channel;
  elements.accountChannel.replaceChildren();
  if (channel) {
    elements.accountChannel.href = channel.url;
    const details = document.createElement("span");
    details.className = "account-channel__details";
    const title = document.createElement("strong");
    title.textContent = t("account.channel", { channel: channel.title });
    const id = document.createElement("span");
    id.textContent = channel.id;
    details.append(title, id);
    elements.accountChannel.append(createAvatar({ author: channel.title, avatar_url: channel.avatar_url }), details);
  } else {
    elements.accountChannel.removeAttribute("href");
  }
  elements.accountStatus.textContent = accountMessage ? localizedErrorMessage(accountMessage, t) : "";
  elements.accountStatus.classList.toggle("is-error", Boolean(accountMessage));
  refreshReplyButtons();
}

async function connectAccount(interactive = true) {
  if (accountBusy || postingReply) return;
  accountBusy = true;
  accountMessage = null;
  refreshAccountUi();
  try {
    await youtubeAccount.connect({ interactive });
    await chrome.storage.local.set({ youtubeAccountConnected: true });
  } catch (error) {
    accountMessage = error;
  } finally {
    accountBusy = false;
    refreshAccountUi();
  }
}

async function disconnectAccount() {
  if (accountBusy || postingReply) return;
  accountBusy = true;
  accountMessage = null;
  refreshAccountUi();
  try {
    await youtubeAccount.disconnect();
    await chrome.storage.local.set({ youtubeAccountConnected: false });
  } catch (error) {
    accountMessage = error;
  } finally {
    accountBusy = false;
    refreshAccountUi();
  }
}

async function restoreAccount() {
  try {
    const saved = await chrome.storage.local.get("youtubeAccountConnected");
    if (saved.youtubeAccountConnected) await connectAccount(false);
  } catch (error) {
    accountMessage = error;
    refreshAccountUi();
  }
}

async function createReplyComposer({ item, comment, thread, videoId }) {
  const channel = youtubeAccount.channel;
  if (!channel || postingReply || !finalState || !thread?.parent?.comment_id) return;
  closeActiveComposer();
  const form = document.createElement("form");
  form.className = "reply-composer";
  form.dataset.channelId = channel.id;
  form.dataset.state = "loading";
  const heading = document.createElement("div");
  heading.className = "reply-composer__heading";
  const title = document.createElement("strong");
  title.textContent = t("reply.heading", { author: comment.author || t("comment.unknownAuthorLower") });
  const counter = document.createElement("span");
  counter.textContent = "0 / 10000";
  heading.append(title, counter);

  const textarea = document.createElement("textarea");
  textarea.className = "reply-composer__input";
  textarea.maxLength = 10_000;
  textarea.rows = 3;
  textarea.disabled = true;
  textarea.placeholder = t("reply.placeholder");
  if (comment.is_reply && comment.author?.startsWith("@")) {
    textarea.value = `${comment.author} `;
    counter.textContent = `${textarea.value.length} / 10000`;
  }
  textarea.addEventListener("input", () => {
    counter.textContent = `${textarea.value.length} / 10000`;
    persistDraft(form.dataset.state === "uncertain" ? "uncertain" : "draft");
  });

  const notice = document.createElement("p");
  notice.className = "reply-composer__notice";
  notice.textContent = t("reply.oauthNotice", { channel: channel.title, id: channel.id });
  const status = document.createElement("p");
  status.className = "reply-composer__status";
  status.setAttribute("aria-live", "polite");
  const actions = document.createElement("div");
  actions.className = "reply-composer__actions";
  const cancel = document.createElement("button");
  cancel.className = "button button--secondary reply-composer__cancel";
  cancel.type = "button";
  cancel.textContent = t("reply.cancel");
  const send = document.createElement("button");
  send.className = "button button--primary reply-composer__send";
  send.type = "submit";
  send.disabled = true;
  send.textContent = t("reply.send");
  actions.append(cancel, send);
  form.append(heading, textarea, notice, status, actions);

  let saveVersion = 0;
  function persistDraft(state, text = textarea.value) {
    const version = ++saveVersion;
    const writing = saveReplyDraft(database, { comment_id: comment.comment_id, channel_id: channel.id, parent_comment_id: thread.parent.comment_id, text, state });
    draftWrites.add(writing);
    writing.then(() => {
      draftWrites.delete(writing);
      if (version === saveVersion && form.dataset.state === "draft" && form.isConnected) {
        status.textContent = t("reply.draftSaved");
        status.className = "reply-composer__status";
      }
    }, () => {
      draftWrites.delete(writing);
      if (version === saveVersion && form.isConnected) {
        status.textContent = t("reply.draftFailed");
        status.className = "reply-composer__status is-error";
      }
    });
    return writing;
  }

  function showUncertain() {
    form.dataset.state = "uncertain";
    send.disabled = true;
    status.textContent = t("error.replyUncertain");
    status.className = "reply-composer__status is-error";
    const checkLink = document.createElement("a");
    checkLink.href = commentUrl(videoId, thread.parent.comment_id);
    checkLink.target = "_blank";
    checkLink.rel = "noreferrer";
    checkLink.className = "youtube-link";
    checkLink.textContent = t("reply.checkThread");
    const reviewed = document.createElement("button");
    reviewed.type = "button";
    reviewed.className = "button button--secondary";
    reviewed.textContent = t("reply.retryChecked");
    reviewed.addEventListener("click", async () => {
      reviewed.disabled = true;
      try {
        await persistDraft("draft");
        form.dataset.state = "draft";
        status.textContent = t("reply.draftSaved");
        status.className = "reply-composer__status";
        refreshReplyButtons();
      } catch {
        reviewed.disabled = false;
      }
    });
    status.append(" ", checkLink, " ", reviewed);
  }

  cancel.addEventListener("click", closeActiveComposer);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (postingReply || form.dataset.state !== "draft") return;
    const text = textarea.value.trim();
    if (!text) {
      status.textContent = t("error.replyEmpty");
      status.className = "reply-composer__status is-error";
      textarea.focus();
      return;
    }

    postingReply = true;
    form.dataset.state = "sending";
    elements.start.disabled = true;
    elements.language.disabled = true;
    elements.clearData.disabled = true;
    elements.download.disabled = true;
    elements.downloadTxt.disabled = true;
    elements.savedVideos.disabled = true;
    elements.reloadSaved.disabled = true;
    elements.importLegacy.disabled = true;
    refreshAccountUi();
    textarea.disabled = true;
    cancel.disabled = true;
    send.disabled = true;
    send.textContent = t("reply.sending");
    status.textContent = "";
    try {
      await withVideoLock(async () => {
        const saved = await chrome.storage.local.get("youtubeAccountConnected");
        if (!saved.youtubeAccountConnected) throw { code: "oauthSignIn" };
        try { await persistDraft("uncertain", text); }
        catch { throw extensionError("draftSaveFailed", "Черновик не удалось сохранить. Ответ не отправлен."); }
        const posted = await youtubeAccount.postReply({ parentId: thread.parent.comment_id, text, expectedChannelId: channel.id });
        form.dataset.state = "sent";
        // Publication is already complete. A local storage failure must not enable a second POST.
        let stored = false;
        try {
          const { inserted, summary } = await storePublishedReply(database, posted, sequence, { comment_id: comment.comment_id, channel_id: channel.id });
          if (inserted) {
            if (renderedSequence === sequence) renderedSequence += 1;
            thread.parent.reply_count = (Number(thread.parent.reply_count) || 0) + 1;
          }
          applyDatasetSummary(summary);
          updatePreviewControls();
          stored = true;
        } catch {
          // The published reply remains visible, with an explicit export warning below.
        }
        attachReply(thread, posted, videoId, { posted: true });
        status.textContent = t("reply.sent");
        status.className = "reply-composer__status is-success";
        notice.textContent = t(stored ? "reply.saved" : "reply.storageFailed");
        textarea.value = "";
        counter.textContent = "0 / 10000";
        send.textContent = t("reply.sentButton");
        cancel.disabled = false;
      });
    } catch (error) {
      if (form.dataset.state === "sent") {
        status.textContent = t("reply.localFailed");
        status.className = "reply-composer__status is-error";
        cancel.disabled = false;
        return;
      }
      textarea.disabled = false;
      cancel.disabled = false;
      form.dataset.state = error.code === "replyUncertain" ? "uncertain" : "draft";
      send.disabled = form.dataset.state === "uncertain";
      send.textContent = t("reply.send");
      const draftSaved = await persistDraft(form.dataset.state).then(() => true, () => false);
      status.textContent = localizedErrorMessage(error, t) + (draftSaved ? "" : ` ${t("reply.draftFailed")}`);
      status.className = "reply-composer__status is-error";
      if (error.code === "replyUncertain") showUncertain();
      textarea.focus();
    } finally {
      postingReply = false;
      elements.start.disabled = false;
      elements.language.disabled = false;
      elements.clearData.disabled = !sequence;
      elements.download.disabled = !sequence;
      elements.downloadTxt.disabled = !sequence;
      elements.savedVideos.disabled = false;
      elements.importLegacy.disabled = false;
      await refreshLibrary();
      refreshAccountUi();
    }
  });

  item.querySelector(".comment__body")?.append(form);
  activeComposer = form;
  try {
    await Promise.all([...draftWrites]);
    const draft = await readReplyDraft(database, comment.comment_id, channel.id);
    if (activeComposer !== form || !form.isConnected) return;
    form.dataset.state = "draft";
    if (draft) {
      textarea.value = draft.text;
      counter.textContent = `${textarea.value.length} / 10000`;
      if (draft.state === "uncertain") showUncertain();
      else status.textContent = t("reply.draftRestored");
    }
    textarea.disabled = false;
    refreshReplyButtons();
  } catch {
    form.dataset.state = "unavailable";
    status.textContent = t("reply.draftFailed");
    status.className = "reply-composer__status is-error";
    return;
  }
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

function createCommentNode(comment, {
  videoId,
  parent = null,
  participants = [],
  thread,
  depth = 0,
  posted = false,
} = {}) {
  const item = document.createElement("div");
  item.className = `comment${comment.is_reply ? ` comment--reply comment--depth-${depth}` : ""}${posted ? " comment--posted" : ""}`;
  item.style.setProperty("--reply-depth", String(depth));
  if (comment.comment_id) item.dataset.commentId = comment.comment_id;
  const body = document.createElement("div");
  body.className = "comment__body";
  const header = document.createElement("div");
  header.className = "comment__header";

  const author = document.createElement("span");
  author.className = "comment__author";
  author.textContent = comment.author || t("comment.unknownAuthor");
  header.append(author);
  const youtubeLink = createYoutubeLink(comment, videoId);
  if (youtubeLink) header.append(youtubeLink);

  if (comment.is_reply) {
    const target = document.createElement("span");
    target.className = "comment__target";
    target.textContent = t("comment.replyTo", {
      author: replyTarget(comment, parent, participants, t("comment.parentAuthor")),
    });
    header.append(target);
  }

  const date = document.createElement("span");
  date.className = "comment__date";
  date.textContent = comment.published_at_text || t("comment.unknownDate");
  header.append(date);

  const text = document.createElement("p");
  text.className = "comment__text";
  text.textContent = comment.text || "";
  const meta = document.createElement("div");
  meta.className = "comment__meta";
  const likes = document.createElement("span");
  likes.textContent = `♥ ${comment.likes || "0"}`;
  meta.append(likes);
  if (!comment.is_reply && Number(comment.reply_count) > 0) {
    const replyInfo = document.createElement("span");
    replyInfo.textContent = t("comment.youtubeReplies", { count: comment.reply_count });
    meta.append(replyInfo);
  }
  if (comment.hearted_by_creator) {
    const heart = document.createElement("span");
    heart.className = "comment__heart";
    heart.textContent = t("comment.creatorHeart");
    meta.append(heart);
  }

  if (posted) {
    const postedBadge = document.createElement("span");
    postedBadge.className = "comment__posted-badge";
    postedBadge.textContent = t("comment.posted");
    meta.append(postedBadge);
  } else {
    const replyButton = document.createElement("button");
    replyButton.className = "comment__reply-button";
    replyButton.type = "button";
    replyButton.textContent = t("reply.action");
    replyButton.dataset.parentId = thread?.parent?.comment_id ?? "";
    replyButton.disabled = !thread?.parent?.comment_id || !youtubeAccount.channel || !finalState || postingReply || accountBusy;
    if (replyButton.disabled) replyButton.title = t(!finalState ? "reply.waitCollection" : "reply.connectFirst");
    replyButton.addEventListener("click", () => {
      void createReplyComposer({ item, comment, thread, videoId });
    });
    meta.append(replyButton);
  }

  body.append(header, text, meta);
  item.append(createAvatar(comment), body);
  return item;
}

function attachReply(thread, reply, videoId, { posted = false } = {}) {
  if (reply.comment_id && renderedCommentIds.has(reply.comment_id)) return;
  const depth = replyDisplayDepth(reply, thread.parent, thread.entries);
  const participants = thread.entries.map((entry) => entry.comment);
  if (!thread.label) {
    thread.label = document.createElement("p");
    thread.label.className = "replies__label";
    thread.replies.append(thread.label);
  }
  thread.replyCount += 1;
  thread.label.textContent = t("comment.threadReplies", { count: thread.replyCount });
  const node = createCommentNode(reply, {
    videoId,
    parent: thread.parent,
    participants,
    thread,
    depth,
    posted: posted || Boolean(reply.sent_by_extension),
  });
  thread.replies.append(node);
  thread.entries.push({ comment: reply, depth });
  if (reply.comment_id) renderedCommentIds.add(reply.comment_id);
}

function renderComments(comments, videoId) {
  if (!comments.length) return;
  if (elements.commentsList.querySelector(".empty-state")) elements.commentsList.replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const comment of comments) {
    if (comment.comment_id && renderedCommentIds.has(comment.comment_id)) continue;
    if (!comment.is_reply) {
      const threadElement = document.createElement("article");
      threadElement.className = "thread";
      const replies = document.createElement("div");
      replies.className = "replies";
      const thread = {
        parent: comment,
        element: threadElement,
        replies,
        entries: [{ comment, depth: 0 }],
        replyCount: 0,
        label: null,
      };
      threadElement.append(createCommentNode(comment, {
        videoId,
        thread,
        posted: Boolean(comment.sent_by_extension),
      }), replies);
      fragment.append(threadElement);
      threadNodes.set(comment.comment_id, thread);
      if (comment.comment_id) renderedCommentIds.add(comment.comment_id);
      for (const reply of pendingReplies.get(comment.comment_id) ?? []) attachReply(thread, reply, videoId);
      pendingReplies.delete(comment.comment_id);
      continue;
    }

    const parentId = comment.parent_comment_id
      || (comment.comment_id?.includes(".") ? comment.comment_id.split(".", 1)[0] : null);
    const thread = threadNodes.get(parentId);
    if (thread) attachReply(thread, comment, videoId);
    else {
      const pending = pendingReplies.get(parentId) ?? [];
      pending.push(comment);
      pendingReplies.set(parentId, pending);
    }
  }
  elements.commentsList.append(fragment);
}

function renderOrphanReplies(videoId) {
  if (orphanRepliesRendered || !pendingReplies.size) return;
  const fragment = document.createDocumentFragment();
  for (const [parentId, replies] of pendingReplies) {
    const orphan = document.createElement("article");
    orphan.className = "thread orphan-thread";
    const label = document.createElement("p");
    label.className = "replies__label";
    label.textContent = t("comment.parentMissing", { id: parentId });
    orphan.append(label);
    for (const reply of replies) orphan.append(createCommentNode(reply, { videoId, participants: replies }));
    fragment.append(orphan);
  }
  elements.commentsList.append(fragment);
  pendingReplies.clear();
  orphanRepliesRendered = true;
}

function emptyPreviewNode() {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  const icon = document.createElement("span");
  icon.textContent = "💬";
  icon.setAttribute("aria-hidden", "true");
  const title = document.createElement("h3");
  title.textContent = t("preview.emptyTitle");
  const description = document.createElement("p");
  description.textContent = t("preview.emptyDescription");
  empty.append(icon, title, description);
  return empty;
}

function resetPreviewDom({ showEmpty = true } = {}) {
  closeActiveComposer();
  threadNodes.clear();
  pendingReplies.clear();
  renderedCommentIds.clear();
  orphanRepliesRendered = false;
  renderedSequence = 0;
  elements.commentsList.replaceChildren(...(showEmpty ? [emptyPreviewNode()] : []));
}

function updatePreviewControls() {
  if (!sequence) {
    elements.previewControls.hidden = true;
    return;
  }
  elements.previewControls.hidden = false;
  elements.previewSummary.textContent = t("preview.summary", { shown: renderedSequence, total: sequence });
  elements.loadMore.hidden = renderedSequence >= sequence;
}

function maybeRenderOrphans(videoId) {
  if (collectionFinished && renderedSequence >= sequence) renderOrphanReplies(videoId);
}

function renderIncoming(comments, videoId) {
  const available = Math.max(0, previewCapacity - renderedSequence);
  const visible = comments.slice(0, available);
  renderComments(visible, videoId);
  renderedSequence += visible.length;
  updatePreviewControls();
}

async function loadMorePreview() {
  if (!database || renderedSequence >= sequence) return;
  elements.loadMore.disabled = true;
  try {
    previewCapacity += PREVIEW_BATCH_SIZE;
    const amount = Math.min(PREVIEW_BATCH_SIZE, sequence - renderedSequence);
    const comments = await readCommentRange(database, renderedSequence, amount);
    renderComments(comments, extractVideoId(runOptions.url));
    renderedSequence += comments.length;
    updatePreviewControls();
    maybeRenderOrphans(extractVideoId(runOptions.url));
  } finally {
    elements.loadMore.disabled = false;
  }
}

async function rerenderPreviewInCurrentLanguage() {
  setBadge(currentBadgeKey, currentBadgeState);
  updateDownloadLabel();
  refreshAccountUi();
  await refreshLibrary();
  if (activeComposer) return;
  if (!database || !sequence || !finalState) return;
  const target = renderedSequence;
  resetPreviewDom({ showEmpty: false });
  const comments = await readCommentRange(database, 0, target);
  renderComments(comments, extractVideoId(runOptions.url));
  renderedSequence = comments.length;
  updatePreviewControls();
  maybeRenderOrphans(extractVideoId(runOptions.url));
  setStatusKey("status.dataReady", { count: sequence });
}

async function waitIfPaused() {
  if (!paused) return;
  await new Promise((resolve) => { resumeCollector = resolve; });
  resumeCollector = null;
  if (abortController.signal.aborted) throw new CollectorStoppedError();
}

function finishUi(state, message) {
  finalState = true;
  clearInterval(timer);
  elements.pause.disabled = true;
  elements.stop.disabled = true;
  elements.start.disabled = false;
  elements.language.disabled = false;
  elements.savedVideos.disabled = false;
  elements.importLegacy.disabled = false;
  elements.progress.classList.add(state === "error" ? "is-error" : "is-done");
  setStatus(message);
  refreshReplyButtons();
}

function enableDownloads(enabled) {
  elements.download.disabled = !enabled;
  elements.downloadTxt.disabled = !enabled;
  elements.clearData.disabled = !enabled;
}

async function performDownload(format, sourceButton) {
  elements.download.disabled = true;
  elements.downloadTxt.disabled = true;
  const label = sourceButton === elements.downloadTxt ? elements.downloadTxtLabel : sourceButton;
  label.textContent = t("download.preparing");
  try {
    const result = await downloadCommentsFromDatabase(database, {
      format,
      videoId: extractVideoId(runOptions.url),
      language: languageController.language,
      forEach: forEachComment,
      readAll: readComments,
    });
    setStatusKey("download.sent", { format: FORMAT_LABELS[format], count: result.count });
  } catch (error) {
    setStatusKey("download.failed", { message: localizedErrorMessage(error, t) });
  } finally {
    updateDownloadLabel();
    enableDownloads(true);
  }
}

async function clearLocalData() {
  if (postingReply) return;
  if (!database || !confirm(t("confirm.clearData"))) return;
  await withVideoLock(async () => {
    await Promise.all([...draftWrites]);
    await clearComments(database);
  });
  sequence = 0;
  topLevelCount = 0;
  replyCount = 0;
  previewCapacity = PREVIEW_BATCH_SIZE;
  resetPreviewDom();
  updatePreviewControls();
  elements.total.textContent = "0";
  elements.comments.textContent = "0";
  elements.replies.textContent = "0";
  enableDownloads(false);
  setStatusKey("status.dataCleared");
  await refreshLibrary();
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (postingReply) return;
  elements.formError.hidden = true;
  let url;
  try {
    url = normalizeYoutubeUrl(elements.url.value.trim());
  } catch (error) {
    elements.formError.textContent = localizedErrorMessage(error, t);
    elements.formError.hidden = false;
    elements.url.focus();
    return;
  }

  const preferences = {
    sort: elements.sort.value,
    format: elements.format.value,
    limit: elements.limit.value,
    delay: elements.delay.value,
    language: languageController.preference,
  };
  await chrome.storage.local.set({ exportPreferences: preferences });
  try { await Promise.all([...draftWrites]); }
  catch {
    elements.formError.textContent = t("reply.draftFailed");
    elements.formError.hidden = false;
    return;
  }
  const nextQuery = new URLSearchParams({ url, action: "collect", ...preferences });
  if (url === runOptions.url && query.get("sourceTabId")) nextQuery.set("sourceTabId", query.get("sourceTabId"));
  location.assign(chrome.runtime.getURL(`collector.html?${nextQuery}`));
});

elements.format.addEventListener("change", updateDownloadLabel);
elements.pause.addEventListener("click", () => {
  paused = !paused;
  if (paused) {
    elements.pause.textContent = t("action.resume");
    setBadge("badge.paused", "paused");
    setStatusKey("status.paused");
  } else {
    elements.pause.textContent = t("action.pause");
    setBadge("badge.running", "running");
    setStatusKey("status.resuming");
    resumeCollector?.();
  }
});

elements.stop.addEventListener("click", () => {
  elements.stop.disabled = true;
  abortController.abort();
  resumeCollector?.();
  setStatusKey("status.stopping");
});
elements.download.addEventListener("click", () => performDownload(elements.format.value, elements.download));
elements.downloadTxt.addEventListener("click", () => performDownload("txt", elements.downloadTxt));
elements.clearData.addEventListener("click", () => clearLocalData().catch((error) => setStatus(localizedErrorMessage(error, t))));
elements.loadMore.addEventListener("click", () => loadMorePreview().catch((error) => setStatus(localizedErrorMessage(error, t))));
elements.savedVideos.addEventListener("change", async () => {
  if (!elements.savedVideos.value || postingReply || !finalState) return;
  try { await Promise.all([...draftWrites]); }
  catch {
    elements.savedVideos.value = database.videoId ?? "";
    setStatus(t("reply.draftFailed"));
    return;
  }
  const next = new URLSearchParams({ url: `https://www.youtube.com/watch?v=${elements.savedVideos.value}`, language: languageController.preference });
  location.assign(chrome.runtime.getURL(`collector.html?${next}`));
});
elements.reloadSaved.addEventListener("click", () => restoreDataset().catch((error) => setStatus(localizedErrorMessage(error, t))));
elements.importLegacy.addEventListener("click", async () => {
  if (postingReply || !finalState) return;
  try {
    const url = normalizeYoutubeUrl(elements.url.value.trim());
    if (!confirm(t("library.confirmLegacy", { url }))) return;
    const imported = await openCommentDatabase(extractVideoId(url));
    try {
      await navigator.locks.request(`youtube-comments-video-${imported.videoId}`, { ifAvailable: true }, async (lock) => {
        if (!lock) throw extensionError("datasetBusy", "Это видео изменяется в другой вкладке.");
        await importLegacyComments(imported);
      });
      await chrome.storage.local.set({ legacyImportedTo: imported.videoId });
    } finally { imported.close(); }
    const next = new URLSearchParams({ url, language: languageController.preference });
    location.assign(chrome.runtime.getURL(`collector.html?${next}`));
  } catch (error) {
    setStatus(localizedErrorMessage(error, t));
  }
});
elements.accountConnect.addEventListener("click", () => connectAccount(true));
elements.accountDisconnect.addEventListener("click", disconnectAccount);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.youtubeAccountConnected?.newValue === false) {
    youtubeAccount.forgetConnection();
    refreshAccountUi();
  }
});

async function start() {
  let normalizedUrl;
  try {
    normalizedUrl = normalizeYoutubeUrl(runOptions.url);
  } catch (error) {
    setBadge("badge.error", "error");
    finishUi("error", localizedErrorMessage(error, t));
    return;
  }

  runOptions.url = normalizedUrl;
  const videoId = extractVideoId(normalizedUrl);
  elements.title.textContent = t("status.collecting");
  elements.videoLink.href = normalizedUrl;
  elements.videoLink.textContent = normalizedUrl;
  elements.details.textContent = [
    t(runOptions.sort === "recent" ? "details.recent" : "details.popular"),
    runOptions.limit ? t("details.limit", { count: runOptions.limit }) : t("details.noLimit"),
    t("details.repliesIncluded"),
    t("details.delay", { delay: runOptions.delay }),
  ].join(" · ");
  elements.start.disabled = true;
  finalState = false;
  collectionFinished = false;
  elements.savedVideos.disabled = true;
  elements.reloadSaved.disabled = true;
  elements.importLegacy.disabled = true;
  elements.language.disabled = true;
  elements.pause.disabled = false;
  elements.stop.disabled = false;
  elements.progress.classList.remove("progress--idle", "is-done", "is-error");

  try {
    await setDatasetState(database, "collecting");
    applyDatasetSummary(await getVideoDataset(database));
    requester = await createYoutubeRequester({
      preferredTabId: Number.parseInt(query.get("sourceTabId") ?? "", 10),
      videoUrl: normalizedUrl,
      onStatus: setStatus,
      t,
    });
    startedAt = Date.now();
    timer = setInterval(() => { elements.elapsed.textContent = formatElapsed(Date.now() - startedAt); }, 1000);
    setBadge("badge.running", "running");

    const result = await collectYoutubeComments({
      ...runOptions,
      language: languageController.language,
      t,
      signal: abortController.signal,
      fetchImpl: requester,
      waitIfPaused,
      onStatus: setStatus,
      onRetry: ({ attempt, wait }) => setStatusKey("status.retry", { attempt, seconds: wait / 1000 }),
      onComments: async (comments) => {
        const publicComments = comments.map((comment) => {
          const cleanComment = { ...comment };
          delete cleanComment._reply_command;
          return cleanComment;
        });
        applyDatasetSummary(await storeComments(database, publicComments));
        const available = Math.max(0, previewCapacity - renderedSequence);
        if (available) renderIncoming(await readCommentRange(database, renderedSequence, available), videoId);
      },
      onProgress: ({ total, pages, queued }) => {
        elements.pages.textContent = String(pages);
        setStatusKey("status.progress", { total, queued });
      },
    });

    setBadge("badge.done", "done");
    await setDatasetState(database, "saved");
    finishUi("done", t(result.exhausted ? "status.completeExhausted" : "status.completeLimit", { total: result.total }));
  } catch (error) {
    await setDatasetState(database, "partial");
    if (error instanceof CollectorStoppedError || abortController.signal.aborted) {
      setBadge("badge.stopped", "done");
      finishUi("done", t("status.stopped", { count: sequence }));
    } else {
      console.error(error);
      setBadge("badge.error", "error");
      finishUi("error", t("status.error", { message: localizedErrorMessage(error, t) }));
    }
  } finally {
    collectionFinished = true;
    if (requester?.ownedTab) {
      await chrome.tabs.remove(requester.tabId).catch(() => {});
      requester = null;
    }
    const visible = Math.max(renderedSequence, PREVIEW_BATCH_SIZE);
    resetPreviewDom();
    const stored = await readCommentRange(database, 0, visible);
    renderIncoming(stored, videoId);
    maybeRenderOrphans(videoId);
    if (database && await countComments(database) > 0) enableDownloads(true);
    updatePreviewControls();
    await refreshLibrary();
    elements.elapsed.textContent = formatElapsed(Date.now() - startedAt);
  }
}

window.addEventListener("beforeunload", (event) => {
  if (postingReply || draftWrites.size) {
    event.preventDefault();
    event.returnValue = "";
    return;
  }
  if (!finalState) abortController.abort();
});
window.addEventListener("pagehide", () => database?.close());

languageController = await initializeLanguageSelect(elements.language, {
  initialPreference: runOptions.language,
  onChange: async () => {
    themeController?.refresh();
    await rerenderPreviewInCurrentLanguage();
  },
});
themeController = await initializeThemeToggle(elements.themeToggle, document.documentElement, t);
populateForm();
elements.accountExtensionId.textContent = chrome.runtime.id;
refreshAccountUi();
void restoreAccount();
try {
  database = await openCommentDatabase(runOptions.url ? extractVideoId(runOptions.url) : null);
  const datasets = await listVideoDatasets(database);
  if (!runOptions.url && datasets.length) {
    runOptions.url = datasets[0].url;
    database.close();
    database = await openCommentDatabase(datasets[0].video_id);
    populateForm();
  }
  const saved = await chrome.storage.local.get("legacyImportedTo");
  elements.legacyNotice.hidden = Boolean(saved.legacyImportedTo) || !await countComments({ ...database, videoId: null });
  await refreshLibrary();
  if (database.videoId) {
    await restoreDataset();
    const collect = query.get("action") === "collect";
    const currentUrl = new URL(location.href);
    currentUrl.searchParams.delete("action");
    currentUrl.searchParams.set("url", runOptions.url);
    history.replaceState(null, "", currentUrl);
    if (collect) await withVideoLock(start);
  }
} catch (error) {
  setBadge("badge.error", "error");
  finishUi("error", localizedErrorMessage(error, t));
}
