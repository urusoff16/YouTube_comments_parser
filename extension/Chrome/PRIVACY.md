# Privacy Policy / Политика конфиденциальности

Effective date / Дата вступления в силу: 2026-10-16

## English

Comment Tree Exporter for YouTube processes a YouTube video URL and public comment data requested by the user: comment text, public author name and channel identifier, reply relationships, displayed date, likes, avatar URL, and direct comment URL. Reply text entered by the user is sent only to YouTube after the user explicitly clicks Send.

Collected and successfully saved posted comments are stored locally in the extension's IndexedDB database. Preferences and a sign-in-enabled flag are stored in Chrome local storage. The extension has no developer-operated server, analytics, advertising, or developer account system. Export requests go to `www.youtube.com`. Optional Google sign-in is handled by Chrome Identity; channel identity and explicitly submitted replies are sent over HTTPS through `www.googleapis.com`. Avatars may load from the image URLs supplied by YouTube.

The OAuth permission `youtube.force-ssl` grants broader YouTube management access than replying alone. The extension uses it only to identify the authorized YouTube channel and publish replies explicitly submitted by the user. Tokens are managed by Chrome Identity and used in request headers; they are not written to the comment database, exports, preferences, or logs. Disconnect clears this extension's cached authorization locally; users can separately revoke Google's grant at https://myaccount.google.com/connections. No AI or MCP service receives comments or credentials in this version.

Local IndexedDB also stores per-video dataset metadata, unsent reply drafts keyed by video/comment/channel, sending states and sent-reply history. Typing or restoring a draft does not send it to YouTube. New collection merges records by ID without deleting other videos or records absent from a later response. **Delete this video** removes the selected video's comments, drafts and sent history after confirmation. An older-version dataset without a video ID is kept as a local backup; it is linked to a video only after explicit user confirmation, and the original backup is retained. Removing the extension clears its local extension storage. Downloaded files remain under the user's control. The local settings also record whether the older dataset was linked.

Permissions are used as follows:

- `activeTab` — detects the current video after a user click;
- `downloads` — saves a user-requested export;
- `scripting` — reconnects the local request bridge to a YouTube tab after an extension update;
- `storage` — stores local preferences and whether sign-in should be restored;
- `identity` — obtains OAuth tokens through Chrome after user-initiated Google sign-in;
- `https://www.youtube.com/*` — loads the selected video page and public comments;
- `https://www.googleapis.com/*` — identifies the authorized YouTube channel and publishes only replies explicitly submitted by the user.

The extension does not sell data, use data for advertising or profiling, or allow its developer to read locally collected comments. This is an independent, unofficial utility and is not produced, endorsed, or supported by YouTube or Google.

## Русский

Comment Tree Exporter для YouTube обрабатывает ссылку на видео и запрошенные пользователем публичные данные комментариев: текст, публичное имя автора и идентификатор канала, связи ответов, отображаемую дату, лайки, ссылку на аватар и прямую ссылку на комментарий. Введённый пользователем текст ответа отправляется только на YouTube после явного нажатия кнопки отправки.

Собранные комментарии и успешно сохранённые опубликованные ответы хранятся локально в IndexedDB расширения. В локальном хранилище Chrome находятся настройки и признак включённого входа. У расширения нет сервера разработчика, аналитики, рекламы или собственной системы аккаунтов. Выгрузка обращается к `www.youtube.com`. Необязательный вход через Google обрабатывает Chrome Identity; данные авторизованного канала и явно отправленные ответы передаются по HTTPS через `www.googleapis.com`. Аватары могут загружаться по адресам изображений, предоставленным YouTube.

Разрешение OAuth `youtube.force-ssl` предоставляет более широкий доступ к управлению YouTube, чем только ответы. Расширение использует его лишь для определения авторизованного канала и публикации явно отправленных пользователем ответов. Токенами управляет Chrome Identity; они используются в заголовках запросов и не записываются в базу комментариев, экспорт, настройки или логи. «Отключить» очищает локально кешированную авторизацию этого расширения; отдельно отозвать разрешение у Google можно на https://myaccount.google.com/connections. В этой версии комментарии и учётные данные не передаются ИИ или MCP-сервисам.

В IndexedDB также хранятся сведения о наборах по видео, неотправленные черновики по видео/комментарию/каналу, состояния отправки и история опубликованных ответов. Ввод и восстановление черновика не отправляют его на YouTube. Новый сбор объединяет ID, не удаляя другие видео и записи, отсутствующие в новой выборке. **Удалить это видео** после подтверждения удаляет комментарии, черновики и историю только выбранного видео. Прежний набор без ID видео остаётся локальной резервной копией; привязка к видео требует явного подтверждения пользователя и не изменяет исходную копию. Удаление расширения очищает его локальное хранилище. Скачанные файлы остаются под контролем пользователя. Настройки также сохраняют факт привязки прежнего набора.

Разрешения используются следующим образом:

- `activeTab` — определяет текущее видео после нажатия пользователя;
- `downloads` — сохраняет запрошенный пользователем файл;
- `scripting` — переподключает локальный посредник запросов к вкладке YouTube после обновления расширения;
- `storage` — хранит локальные настройки и признак восстановления входа;
- `identity` — получает OAuth-токены через Chrome после инициированного пользователем входа Google;
- `https://www.youtube.com/*` — загружает страницу выбранного видео и публичные комментарии;
- `https://www.googleapis.com/*` — определяет авторизованный канал YouTube и публикует только явно отправленные пользователем ответы.

Расширение не продаёт данные, не использует их для рекламы или профилирования и не позволяет разработчику читать локально собранные комментарии. Это независимый неофициальный инструмент, не созданный, не одобренный и не поддерживаемый YouTube или Google.
