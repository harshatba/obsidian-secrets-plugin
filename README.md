# Secrets - Obsidian Plugin

Apple Notes-style per-note protection for Obsidian. Protect individual notes with AES-256-GCM encryption and unlock them with Touch ID on Mac or a PIN/passcode on mobile.

## Features

- **Per-note encryption** - Protect any markdown note; encrypted at rest and unsearchable when locked
- **Touch ID** - Unlock notes with biometrics on macOS (via LocalAuthentication framework)
- **PIN / Passcode** - Numeric PIN or alphanumeric passcode for mobile (iOS/Android) and as a fallback on desktop
- **Cross-device sync** - Protect a note on iPhone, unlock it on Mac (encryption key syncs via iCloud)
- **Auto-lock** - Configurable timeout to automatically lock notes after inactivity
- **Lock on blur** - Optionally lock all notes when Obsidian loses focus
- **Native UI** - Lock screen overlay, action icons in Obsidian's view header, file menu integration

## How It Works

1. **Protect a note** - Use the lock icon in the view header or right-click a file and select "Protect note"
2. **Set a passcode** - On first use, choose a numeric PIN or alphanumeric passcode (shared across all protected notes)
3. **Authenticate** - Touch ID on Mac, or enter your PIN/passcode on mobile (Obsidian plugins can't access Face ID on iOS)
4. **View & edit** - Unlocked notes render markdown in reading mode; switch to edit mode via the pencil icon
5. **Lock** - Notes auto-lock after a timeout, or lock manually via the lock icon

Protected notes are stored with AES-256-GCM encryption using PBKDF2-SHA256 key derivation (600,000 iterations). The encrypted content is wrapped in markers inside the markdown file, making it safe to sync with any cloud service.

## Installation

### From source

```bash
git clone https://github.com/<your-username>/obsidian-secrets-plugin.git
cd obsidian-secrets-plugin
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` to your vault's `.obsidian/plugins/obsidian-secrets/` directory.

### Manual install

1. Download the latest release (`main.js`, `manifest.json`, `styles.css`)
2. Create a folder at `<vault>/.obsidian/plugins/obsidian-secrets/`
3. Copy the three files into that folder
4. Enable the plugin in Obsidian Settings > Community Plugins

## Development

```bash
npm install
npm run dev    # watch mode
npm run build  # production build
```

## Security

- **AES-256-GCM** encryption with random 12-byte IV per encrypt operation
- **PBKDF2-SHA256** with 600,000 iterations for key derivation
- Encryption key cached in macOS Keychain and synced via plugin data for mobile
- PIN/passcode hashed with PBKDF2 before storage (never stored in plaintext)
- Rate limiting on failed passcode attempts with exponential backoff

## License

MIT
