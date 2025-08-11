# Change Log

All notable changes to the "CodeSync" extension will be documented in this file.

## [1.0.0] - 2025-01-15

### Added
- Initial release of CodeSync extension
- GitHub/Microsoft authentication integration
- Auto-sync on file save functionality
- Cross-device file restoration
- Empty workspace detection
- Complete workspace sync with progress indicators
- Smart file filtering (js, jsx, ts, tsx, css, html, etc.)
- Nested folder structure support
- Login/logout functionality
- Status checking commands
- Debug commands for troubleshooting

### Features
- **Seamless Authentication**: One-click login using VS Code accounts
- **Auto-sync**: Files sync automatically on Ctrl+S
- **Cross-device Magic**: Restore files on new devices instantly  
- **Smart Detection**: Empty workspace vs existing files scenarios
- **Progress Feedback**: Status bar notifications and progress bars

### Supported File Types
- JavaScript: .js, .jsx, .ts, .tsx
- Web: .html, .css, .scss, .json
- Documentation: .md, .txt
- Other: .vue, .svelte, .py, .java, .cpp, .go, .rs

### Commands Added
- `CodeSync: Login` - Authenticate and activate syncing
- `CodeSync: Logout` - Sign out and stop syncing  
- `CodeSync: Status` - Check current sync status
- `CodeSync: Sync Workspace` - Force upload all files
- `CodeSync: Download Workspace` - Force restore from cloud
- `CodeSync: Debug Auth` - Check authentication state
- `CodeSync: Debug Files` - List all cloud files
