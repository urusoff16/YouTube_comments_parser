# Version 1.3.0 / Версия 1.3.0 — saved videos and drafts

- Separate datasets per video; refresh merges IDs / Отдельные наборы по видео и обновление без дубликатов.
- Restore local data without network collection / Восстановление без повторного сетевого сбора.
- Account-scoped persistent drafts and unknown sending state / Сохраняемые черновики по аккаунту и состояние неизвестной отправки.
- Atomic sent history and scoped deletion / Атомарная история отправки и удаление выбранного видео.
- Original v1 database retained as a backup; explicit video association / Прежняя база сохранена; привязка к видео только по подтверждению.
- 37 unit tests and 24 mocked-browser scenarios with real IndexedDB / 37 модульных тестов и 24 браузерных сценария с подставным API и настоящим IndexedDB.

User confirmed real OAuth sign-in and posting in 1.2.0. Actual upgrade of the user's database to 1.3.0 remains to be checked. MCP and monitoring are not included. / Пользователь подтвердил живой вход и отправку в 1.2.0. Обновление его базы до 1.3.0 ещё предстоит проверить. MCP и мониторинг не входят.

## Previous version 1.2.0 / Предыдущая версия 1.2.0

После добавления email в Google test users пользователь подтвердил вход и публикацию в нужной ветке. Public release still requires a matching permanent extension ID and appropriate Google OAuth configuration/review.

- Google OAuth sign-in, authorized channel identity and disconnect / Google-вход, отображение авторизованного канала и отключение.
- Official API replies with channel revalidation, no automatic write retries / Ответы через официальный API с проверкой канала и без автоматического повторения POST.
- Posted replies saved locally for export / Сохранение опубликованных ответов в локальный экспорт.
- RU/EN account UI, light/dark styles and updated privacy policy / RU/EN, обе темы и обновлённая политика конфиденциальности.
- 37 unit tests and mocked browser acceptance; user subsequently confirmed actual posting / 37 модульных тестов и браузерная проверка; затем пользователь подтвердил реальную отправку.

## Previous version 1.1.0 / Предыдущая версия 1.1.0

- Исправлен запуск сбора через уже открытую вкладку YouTube после обновления расширения.
- Расширение переиспользует подходящую вкладку вместо создания лишней.
- Добавлены цветная иерархия, подписи адресатов и ответ прямо из карточки.
- Обновлён парсер команд ответа под текущую toolbar-структуру YouTube.
- Fixed collection through an already-open YouTube tab after an extension update.
- Reuses a suitable YouTube tab instead of opening an unnecessary helper tab.
- Added colored reply hierarchy, recipient labels, and inline reply composer.
- Updated reply-command parsing for YouTube's current toolbar entity structure.

## Previous version 1.0.0

- Полный интерфейс на русском и английском языках.
- Автоматический выбор языка Chrome и ручной переключатель.
- Локализованные ошибки, статусы и TXT-экспорт.
- Порционный предпросмотр по 300 записей.
- Курсорный экспорт JSON, JSONL и CSV из IndexedDB.
- Удаление локально сохранённых комментариев.
- Встроенная двуязычная политика конфиденциальности.
- Обновлённая production-эмблема и двуязычные метаданные Manifest V3.
- English and Russian UI with automatic Chrome-language detection.
- Localized errors, status messages, and threaded TXT output.
- Batched previews and memory-efficient cursor-based dataset exports.
