# YouTube Comments Parser

## English

An independent Chrome extension and Python command-line tool for collecting available YouTube comments and replies. The extension displays threaded conversations, exports JSON, JSONL, CSV and readable TXT, keeps per-video local collections and drafts, and can post user-written replies through Google OAuth and the YouTube Data API. The Python tool exports public comments to JSON. Firefox and Opera folders are reserved for future versions.

To install the Chrome extension, open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and choose `extension/Chrome`. Google sign-in requires a properly configured OAuth client bound to the extension ID; the existing client is configured for the owner's installation. See the [Chrome instructions](extension/Chrome/README.md) and [privacy policy](extension/Chrome/PRIVACY.md).

Comment collection uses an unofficial YouTube interface, which may change or restrict access. Posting replies uses the official API and its quota. MCP integration and background monitoring are planned, not implemented. This project is not affiliated with or endorsed by YouTube or Google.

## Русский

Независимое расширение Chrome и консольный инструмент Python для сбора доступных комментариев и ответов YouTube. Расширение показывает ветки, выгружает JSON, JSONL, CSV и TXT, сохраняет наборы по видео и черновики, а также позволяет отправлять написанные пользователем ответы через Google OAuth и YouTube Data API.

Расширение устанавливается через `chrome://extensions`: включите режим разработчика, выберите «Загрузить распакованное расширение» и укажите папку `extension/Chrome`. Для входа нужен OAuth-клиент, привязанный к ID расширения; текущий клиент настроен для установки владельца. Подробности: [инструкция Chrome](extension/Chrome/README.md) и [политика конфиденциальности](extension/Chrome/PRIVACY.md).

Сбор использует неофициальный интерфейс YouTube, который может измениться или ограничить доступ. Отправка ответов работает через официальный API и расходует его квоту. MCP и фоновый мониторинг пока планируются. Проект не связан с YouTube или Google и не одобрен ими.

## License / Лицензия

PolyForm Strict License 1.0.0. This is a source-available, noncommercial license; it does not grant permission to distribute the software or make modifications or derivative works. See [LICENSE](LICENSE). / Некоммерческая лицензия с доступным исходным кодом; она не предоставляет разрешения на распространение программы, создание изменений и производных работ. Полные условия приведены в [LICENSE](LICENSE).

CLI-скрипт выгружает доступные публичные комментарии и ответы к видео YouTube в обычный JSON-файл без ключа YouTube Data API.

Версия для браузера находится в [`extension/Chrome`](extension/Chrome). Она умеет показывать древовидный предпросмотр комментариев и экспортировать читаемую иерархию в TXT для Блокнота. Папки `extension/Mozilla` и `extension/Opera` зарезервированы под отдельные браузерные сборки.

## Установка на Windows

```powershell
py -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

## Запуск

```powershell
.venv\Scripts\python.exe youtube_comments_parser.py "https://www.youtube.com/watch?v=VIDEO_ID"
```

По умолчанию результат сохраняется в текущей папке как `VIDEO_ID_comments.json`, сначала идут популярные комментарии. Ответы также включаются.

Полезные параметры:

```text
-o comments.json       другой путь к файлу
--sort recent          сначала новые комментарии
--limit 100            только первые 100 записей для проверки
--language ru          русский язык служебных дат YouTube
--delay 0.5            более бережная пауза между страницами
--force                разрешить перезапись существующего файла
```

Пример безопасного тестового запуска:

```powershell
.venv\Scripts\python.exe youtube_comments_parser.py "https://youtu.be/VIDEO_ID" --limit 100 -o test_comments.json
```

## Формат результата

Итог — корректный JSON-массив. Каждая запись содержит ID комментария, автора, канал автора, текст, дату, число лайков в исходном представлении YouTube, число ответов, признак ответа, отметку автора видео и URL аватара. Значение `likes` намеренно не преобразуется в число: YouTube может вернуть локализованные сокращения вроде `1,2 тыс.` или `1.2K`.

Запись идет постепенно во временный файл, поэтому объем оперативной памяти не растет вместе с числом комментариев. Готовый файл появляется только после успешного завершения; при ошибке или `Ctrl+C` временный файл удаляется.

## Ограничения

Это не официальный YouTube Data API. Суточной квоты Data API здесь нет, но полной «безлимитности» тоже нет: YouTube может менять внутренний протокол, ограничивать частоту запросов или временно блокировать IP. Скрипт получает только комментарии, доступные без авторизации; удаленные, скрытые модерацией и недоступные по региону записи получить нельзя. Используйте инструмент умеренно и с учетом правил YouTube и применимого законодательства.
