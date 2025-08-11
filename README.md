# CodeSync - Cross-Device Code Sync

**Automatically sync your code across multiple devices without Git commits**

## What is CodeSync?

CodeSync makes your code instantly available on any device. Work on your laptop, switch to desktop, and your files are already there!

## Features

✅ **Auto-sync on save** - Every Ctrl+S syncs your files  
✅ **One-click login** - Uses your GitHub/Microsoft account  
✅ **Cross-device magic** - Code appears on all your devices  
✅ **Smart filtering** - Only syncs code files (no node_modules)  
✅ **Safe deletion** - Deleted local files stay in cloud  

## Quick Start

### Installation
1. Install CodeSync from VS Code Extensions
2. Press `Ctrl+Shift+P` → "CodeSync: Login"
3. Grant permissions
4. Start coding normally!

### How it works
1. **Device A**: Code and save → Files sync to cloud
2. **Device B**: Login → "Restore files?" → Yes → All files appear

## Commands

| Command | What it does |
|---------|-------------|
| `CodeSync: Login` | Start syncing |
| `CodeSync: Status` | Check sync status |
| `CodeSync: Download Workspace` | Restore all files |
| `CodeSync: Sync Workspace` | Upload all files |

## Supported Files

✅ JavaScript, TypeScript, HTML, CSS, JSON, Python, Java, Go, Rust, etc.  
❌ node_modules, .git, dist, build (automatically excluded)

## FAQ

**Q: Do I need Git?**  
A: No! CodeSync works independently of Git.

**Q: What if I delete files locally?**  
A: Cloud files are safe. Use "Download Workspace" to restore.

**Q: Is it secure?**  
A: Yes! Uses your personal GitHub/Microsoft account and encrypted storage.

## Troubleshooting

**Extension not working?**
1. Make sure you're signed into GitHub/Microsoft in VS Code
2. Try `CodeSync: Debug Auth`
3. Restart VS Code

**Files not syncing?**
1. Check internet connection
2. Try `CodeSync: Status`
3. Manual sync: `CodeSync: Sync Workspace`

## Perfect For

- Working between home and office
- Switching between laptop and desktop
- Quick file access without Git commits
- Backup your work automatically

---

**Ready to sync?** Install CodeSync and never worry about file access again! 🚀
