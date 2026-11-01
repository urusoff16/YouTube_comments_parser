# Comment Tree Exporter for YouTube 1.3.0

Publication draft. The user confirmed actual OAuth sign-in and posting in 1.2.0. Version 1.3.0 adds per-video datasets and persistent drafts; upgrading the user's own database remains to be checked. Before public release, establish a permanent extension ID and check OAuth verification requirements.

![Comment Tree Exporter forum banner](assets/forum-hero-16x9.png)

A polished local Chrome extension for exporting public YouTube comments, replies, and thread structure without an API key or a separate server.

## Features

- threaded comment and reply preview inside the extension;
- one-click links to exact comments on YouTube;
- JSON, JSONL, CSV, and readable threaded TXT exports;
- English, Russian, and automatic language selection;
- light and dark themes;
- sort order, record limit, and request delay controls;
- pause, resume, stop, and partial-result downloads;
- local-only comment storage with a dedicated delete button.

## Installation

1. Download the archive and verify its SHA-256 checksum.
2. Extract it to a permanent folder.
3. Open `chrome://extensions`.
4. Enable Developer mode.
5. Click “Load unpacked” and select the folder containing `manifest.json`.

This is an independent, unofficial utility and is not affiliated with YouTube or Google. It relies on an internal YouTube interface, so the service may temporarily restrict requests or change response formats. Unlimited or guaranteed operation is not promised.
