import assert from "node:assert/strict";

export async function runPersistenceChecks({ browser, origin, boot, connectAndCompose }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${origin}/tests/visual-fixture.html`);
  const verified = await page.evaluate(async () => {
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    const old = await new Promise((resolve, reject) => {
      const request = indexedDB.open("youtube-comments-exporter", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("comments", { keyPath: "comment_id" }).createIndex("sequence", "sequence", { unique: true });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = old.transaction("comments", "readwrite");
      tx.objectStore("comments").put({ comment_id: "legacy-root", author: "Legacy author", text: "Preserved original", is_reply: false, sequence: 7 });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    old.close();
    const db = await import("/src/database.js");
    const exp = await import("/src/export.js");
    const legacy = await db.openCommentDatabase();
    check(await db.countComments(legacy) === 1, "Migration lost legacy records");
    check((await db.listVideoDatasets(legacy)).length === 0, "Migration guessed a video ID");
    const a = await db.openCommentDatabase("i2NB2bRZO-Y");
    const b = await db.openCommentDatabase("8_DfIWtDY8o");
    const root = { comment_id: "root", author: "@alpha", text: "Original", is_reply: false, reply_count: 0 };
    await db.storeComments(a, [root, { ...root, text: "Updated" }]);
    await db.storeComments(b, [{ ...root, author: "@beta", text: "Other video" }]);
    await Promise.all([
      db.storeComments(a, [{ ...root, comment_id: "second" }]),
      db.storeComments(a, [{ ...root, comment_id: "third" }]),
    ]);
    check((await db.getVideoDataset(a)).total === 3, "Concurrent writes lost counts");
    check((await db.readCommentRange(a, 1, 1)).length === 1, "Range paging failed");
    check((await db.readComments(b))[0].text === "Other video", "Video datasets mixed");
    await db.saveReplyDraft(a, { comment_id: "root", channel_id: "owner", text: "Pending", state: "uncertain" });
    await db.saveReplyDraft(a, { comment_id: "root", channel_id: "other", text: "Other channel", state: "draft" });
    await db.saveReplyDraft(b, { comment_id: "root", channel_id: "owner", text: "Other video draft", state: "draft" });
    check((await db.readReplyDraft(a, "root", "owner")).state === "uncertain", "Unknown sending state lost");
    const posted = { comment_id: "posted", parent_comment_id: "root", author: "Owner", author_channel_id: "owner", text: "Published reply", is_reply: true };
    const target = { comment_id: "root", channel_id: "owner" };
    await db.storePublishedReply(a, posted, 0, target);
    await db.storePublishedReply(a, posted, 0, target);
    check((await db.getVideoDataset(a)).total === 4, "Posted ID duplicated");
    check((await db.readComments(a))[0].reply_count === 1, "Parent counted twice");
    check(await db.readReplyDraft(a, "root", "owner") === null, "Sent draft was not removed");
    check((await db.readReplyDraft(a, "root", "other")).text === "Other channel", "Another channel draft was removed");
    check((await db.listSentReplies(a)).length === 1, "History duplicated or missing");
    await db.storeComments(a, [posted]);
    check((await db.readComments(a)).find((comment) => comment.comment_id === "posted").sent_by_extension, "Refresh lost posted marker");
    const options = { videoId: a.videoId, language: "en", forEach: db.forEachComment, readAll: db.readComments };
    const json = await exp.createDatabaseExportBlob(a, { ...options, format: "json" });
    const txt = await exp.createDatabaseExportBlob(a, { ...options, format: "txt" });
    check(JSON.parse(await json.blob.text()).some((comment) => comment.comment_id === "posted"), "Posted reply missing from JSON");
    check((await txt.blob.text()).includes("Published reply"), "Posted reply missing from TXT");
    check(!(await json.blob.text()).includes('"video_id"'), "Storage metadata leaked into export");
    await db.importLegacyComments(a);
    await db.importLegacyComments(a);
    check((await db.getVideoDataset(a)).total === 5, "Legacy import duplicated IDs");
    check(await db.countComments(legacy) === 1, "Legacy backup was modified");
    await db.clearComments(a);
    check(await db.getVideoDataset(a) === null, "Video metadata survived deletion");
    check(await db.countComments(a) === 0, "Video comments survived deletion");
    check(await db.readReplyDraft(a, "root", "other") === null, "Video draft survived deletion");
    check((await db.listSentReplies(a)).length === 0, "Video history survived deletion");
    let rejectedDeletedDraft = false;
    try { await db.saveReplyDraft(a, { comment_id: "root", channel_id: "owner", text: "Stale tab", state: "draft" }); }
    catch (error) { rejectedDeletedDraft = error.code === "datasetMissing"; }
    check(rejectedDeletedDraft, "A stale tab recreated a deleted video's draft");
    check(await db.countComments(b) === 1, "Another video was deleted");
    check((await db.readReplyDraft(b, "root", "owner")).text === "Other video draft", "Another video's draft was deleted");
    check(await db.countComments(legacy) === 1, "Legacy backup was deleted");
    for (const handle of [legacy, a, b]) handle.close();
    return true;
  });
  assert.equal(verified, true);
  await context.close();

  const ui = await boot();
  await connectAndCompose(ui.page);
  const draft = "Saved draft survives switching and page reload";
  await ui.page.locator(".reply-composer__input").fill(draft);
  await ui.page.waitForFunction(() => document.querySelector(".reply-composer__status").textContent.includes("Черновик сохранён"));
  const requests = await ui.page.evaluate(() => window.__smoke.proxyRequests);
  await ui.page.reload();
  await ui.page.locator("#account-channel").waitFor({ state: "visible" });
  await ui.page.waitForFunction(() => document.querySelector("#saved-videos").options.length === 2);
  assert.equal(await ui.page.evaluate(() => window.__smoke.proxyRequests), requests, "Reload unexpectedly collected comments");
  await ui.page.locator(".comment__reply-button").first().click();
  await ui.page.waitForFunction(() => document.querySelector(".reply-composer__input").value.startsWith("Saved draft"));
  assert.equal(await ui.page.locator(".reply-composer__input").inputValue(), draft);
  await ui.page.evaluate(async () => {
    const db = await import("/src/database.js");
    const other = await db.openCommentDatabase("8_DfIWtDY8o");
    await db.storeComments(other, [{ comment_id: "other-root", author: "@other", text: "Only in second video", is_reply: false }]);
    other.close();
  });
  await ui.page.locator("#reload-saved").click();
  await ui.page.waitForFunction(() => document.querySelector("#saved-videos").options.length === 3);
  await ui.page.locator("#saved-videos").selectOption("8_DfIWtDY8o");
  await ui.page.waitForFunction(() => document.querySelector('[data-comment-id="other-root"]'));
  assert.equal(await ui.page.locator('[data-comment-id="root-id"]').count(), 0);
  await ui.page.locator("#saved-videos").selectOption("i2NB2bRZO-Y");
  await ui.page.locator('[data-comment-id="root-id"]').waitFor();
  await ui.page.locator("#account-channel").waitFor({ state: "visible" });
  await ui.page.locator(".comment__reply-button").first().click();
  await ui.page.waitForFunction(() => document.querySelector(".reply-composer__input").value.startsWith("Saved draft"));
  await ui.page.locator("#start-button").click();
  await ui.page.locator(".badge--done").waitFor();
  assert.equal(await ui.page.locator("#total-count").textContent(), "1", "Refresh duplicated root ID");
  await ui.page.locator("#account-channel").waitFor({ state: "visible" });
  await ui.page.locator(".comment__reply-button").first().click();
  await ui.page.waitForFunction(() => document.querySelector(".reply-composer__input").value.startsWith("Saved draft"));
  const blocker = await ui.context.newPage();
  await blocker.goto(`${origin}/tests/visual-fixture.html`);
  await blocker.evaluate(() => {
    navigator.locks.request("youtube-comments-video-i2NB2bRZO-Y", () => new Promise((resolve) => { window.releaseVideoLock = resolve; }));
  });
  await blocker.waitForFunction(() => typeof window.releaseVideoLock === "function");
  await ui.page.locator(".reply-composer__send").click();
  await ui.page.waitForFunction(() => document.querySelector(".reply-composer__status").textContent.includes("другой вкладке"));
  assert.equal(ui.posts, 0, "Published while another tab owned the data lock");
  await blocker.evaluate(() => window.releaseVideoLock());
  await blocker.close();
  const popup = await ui.context.newPage();
  await popup.goto(`${origin}/popup.html`);
  const openingLibrary = popup.waitForEvent("popup");
  await popup.locator(".library-shortcut").click();
  const library = await openingLibrary;
  await library.waitForFunction(() => document.querySelector("#saved-videos")?.value === "i2NB2bRZO-Y");
  assert.equal(await library.locator("#total-count").textContent(), "1");
  assert.equal(await library.evaluate(() => window.__smoke.proxyRequests), 0, "Opening the library started network collection");
  await ui.context.close();
  return ["v1-migration-backup", "video-isolation", "concurrent-upserts", "draft-account-isolation", "atomic-post-history", "json-txt-posted-export", "explicit-legacy-import", "scoped-delete", "reload-without-network", "draft-recovery", "video-switch", "refresh-deduplication", "cross-tab-write-lock", "popup-library-entry"];
}
