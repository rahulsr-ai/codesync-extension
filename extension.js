const vscode = require("vscode");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");

// =======================
// Configuration
// =======================

const BACKEND_BASE_URL = "http://localhost:4000";

const EXCLUDE_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".vscode",
  ".next",
  "coverage",
  ".nyc_output",
  ".turbo",
  ".cache"
];

const INCLUDE_EXTS = [
  ".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte",
  ".py", ".java", ".cpp", ".c", ".go", ".rs",
  ".json", ".md", ".txt", ".css", ".html", ".scss"
];

// =======================
// Extension lifecycle
// =======================

function activate(context) {
  console.log("CodeSync extension activated!");

  initializeExtension(context);

  // Auto-sync on save (handles both manual Ctrl+S and auto-save)
  const saveDisposable = vscode.workspace.onDidSaveTextDocument((document) => {
    autoSyncFile(document, context);
  });
  context.subscriptions.push(saveDisposable);

  // Commands
  const statusCmd = vscode.commands.registerCommand("code-sync.status", () => showSyncStatus(context));
  const syncAllCmd = vscode.commands.registerCommand("code-sync.syncWorkspace", () => syncEntireWorkspace(context));
  const debugAuthCmd = vscode.commands.registerCommand("code-sync.debugAuth", async () => {
    const info = await tryResolveVSCodeAccountSilent();
    if (info.found) {
      vscode.window.showInformationMessage(`✅ Found: ${info.email} (${info.provider})`);
    } else {
      vscode.window.showErrorMessage("❌ No account found in VS Code (GitHub/Microsoft).");
    }
  });

  const debugAuthInteractiveCmd = vscode.commands.registerCommand("code-sync.debugAuthInteractive", async () => {
    const info = await tryResolveVSCodeAccountInteractive();
    if (info.found) {
      context.globalState.update("codesync_user", { email: info.email, provider: info.provider, active: true });
      
      // Trigger full sync on new interactive login
      const syncKey = `fullSyncDone_${info.email}`;
      await context.globalState.update(syncKey, false); // Reset for fresh full sync
      vscode.window.showInformationMessage(`✅ CodeSync enabled for ${info.email}`);
      
      // Trigger immediate full sync
      await performFirstTimeSync(context, info.email);
    } else {
      vscode.window.showErrorMessage("❌ Could not obtain a session.");
    }
  });

  // Login Command
  const loginCmd = vscode.commands.registerCommand("code-sync.login", async () => {
    const userInfo = context.globalState.get("codesync_user");
    
    if (userInfo?.active) {
      await showSyncStatus(context);
    } else {
      // Force interactive login for logged out users
      const info = await tryResolveVSCodeAccountInteractive();
      if (info.found) {
        context.globalState.update("codesync_user", { 
          email: info.email, 
          provider: info.provider, 
          active: true 
        });
        
        // Check for cross-device restore after login
        await handleCrossDeviceRestore(context, info.email);
        vscode.window.showInformationMessage(`✅ CodeSync active: ${info.email}`);
      } else {
        vscode.window.showErrorMessage("❌ Could not access your VS Code account session.");
      }
    }
  });

  // Logout Command
  const logoutCmd = vscode.commands.registerCommand("code-sync.logout", async () => {
    await logoutUser(context);
  });

  // Manual Download Command
  const downloadCmd = vscode.commands.registerCommand("code-sync.downloadWorkspace", async () => {
    const userInfo = context.globalState.get("codesync_user");
    if (!userInfo?.active) {
      vscode.window.showErrorMessage("❌ Please login first");
      return;
    }
    
    await downloadWorkspaceFromCloud(context, userInfo.email);
  });

  // Debug Files Command (for troubleshooting nested files)
  const debugFilesCmd = vscode.commands.registerCommand("code-sync.debugFiles", async () => {
    const userInfo = context.globalState.get("codesync_user");
    if (!userInfo?.active) {
      vscode.window.showErrorMessage("❌ Please login first");
      return;
    }
    
    try {
      const response = await axios.get(`${BACKEND_BASE_URL}/files/${encodeURIComponent(userInfo.email)}`);
      const files = response.data.files;
      
      console.log("=== DEBUG: Files found in cloud ===");
      files.forEach((file, index) => {
        console.log(`${index + 1}. ${file.relativePath} (${file.size} bytes)`);
      });
      console.log("=== End debug ===");
      
      vscode.window.showInformationMessage(`Found ${files.length} files. Check console for details.`);
    } catch (error) {
      console.error("Debug files error:", error);
      vscode.window.showErrorMessage(`Debug failed: ${error.message}`);
    }
  });

  context.subscriptions.push(statusCmd, syncAllCmd, debugAuthCmd, debugAuthInteractiveCmd, loginCmd, logoutCmd, downloadCmd, debugFilesCmd);
}

function deactivate() {}

// =======================
// Init & account detection
// =======================

async function initializeExtension(context) {
  try {
    console.log("Initializing CodeSync...");
    
    // Check if user manually logged out
    const userInfo = context.globalState.get("codesync_user");
    if (userInfo === undefined) {
      // User hasn't used extension or logged out
      vscode.window.showInformationMessage(
        "👋 Welcome to CodeSync! Use 'CodeSync: Login' to get started.",
        "Login Now"
      ).then(choice => {
        if (choice === "Login Now") {
          vscode.commands.executeCommand("code-sync.login");
        }
      });
      return;
    }

    if (userInfo && !userInfo.active) {
      // User exists but logged out
      vscode.window.showInformationMessage(
        "CodeSync is inactive. Use 'CodeSync: Login' to resume syncing."
      );
      return;
    }

    // Try to get account silently for active users
    const accountInfo = await tryResolveVSCodeAccountSilent();
    console.log("User info result (silent):", accountInfo);

    if (!accountInfo.found) {
      const choice = await vscode.window.showWarningMessage(
        "CodeSync: Sign in to GitHub or Microsoft and grant access to enable auto-sync.",
        "Grant Access",
        "Later"
      );
      if (choice === "Grant Access") {
        const granted = await tryResolveVSCodeAccountInteractive();
        console.log("User info result (interactive):", granted);
        if (granted.found) {
          context.globalState.update("codesync_user", {
            email: granted.email,
            provider: granted.provider,
            active: true
          });
          
          // Check if this is a new device and offer to restore files
          await handleCrossDeviceRestore(context, granted.email);
          vscode.window.showInformationMessage(`✅ CodeSync active: ${granted.email}`);
        } else {
          vscode.window.showWarningMessage("CodeSync: Could not access your VS Code account session.");
        }
      }
      return;
    }

    context.globalState.update("codesync_user", {
      email: accountInfo.email,
      provider: accountInfo.provider,
      active: true
    });

    // Check for cross-device restore or first-time sync
    const syncKey = `fullSyncDone_${accountInfo.email}`;
    const fullSyncDone = context.globalState.get(syncKey);

    if (!fullSyncDone) {
      // Check if this is a new device with existing cloud files
      await handleCrossDeviceRestore(context, accountInfo.email);
    }

    console.log("CodeSync initialized successfully");
    vscode.window.showInformationMessage(`✅ CodeSync active: ${accountInfo.email}`);

  } catch (error) {
    console.error("Initialization error:", error);
    vscode.window.showErrorMessage(`❌ CodeSync init failed: ${error.message}`);
  }
}

// =======================
// Cross-Device Restore Logic
// =======================

async function handleCrossDeviceRestore(context, userEmail) {
  try {
    const wsFolders = vscode.workspace.workspaceFolders;
    if (!wsFolders?.length) {
      console.log("No workspace folder - skipping restore check");
      return;
    }

    const workspacePath = wsFolders[0].uri.fsPath;
    const isEmpty = isWorkspaceEmpty(workspacePath);

    if (isEmpty) {
      // Workspace is empty - likely new device, check for cloud files
      const choice = await vscode.window.showInformationMessage(
        "🔍 Empty workspace detected. Would you like to restore your files from the cloud?",
        "Yes, Restore Files",
        "No, Start Fresh",
        "Later"
      );

      if (choice === "Yes, Restore Files") {
        const restored = await downloadWorkspaceFromCloud(context, userEmail);
        if (restored) {
          // Mark as synced since we just restored everything
          const syncKey = `fullSyncDone_${userEmail}`;
          await context.globalState.update(syncKey, true);
        }
      } else if (choice === "No, Start Fresh") {
        // Perform first-time sync (upload current workspace)
        await performFirstTimeSync(context, userEmail);
      }
    } else {
      // Workspace has files - perform first-time sync to upload them
      await performFirstTimeSync(context, userEmail);
    }

  } catch (error) {
    console.error("Cross-device restore failed:", error);
    vscode.window.showErrorMessage(`❌ Restore check failed: ${error.message}`);
  }
}

// =======================
// First Time Full Sync
// =======================

async function performFirstTimeSync(context, userEmail) {
  try {
    vscode.window.showInformationMessage("🔄 First time login detected, syncing entire workspace...");
    
    // Perform full workspace sync
    await syncEntireWorkspace(context);
    
    // Mark as synced for this user
    const syncKey = `fullSyncDone_${userEmail}`;
    await context.globalState.update(syncKey, true);
    
    vscode.window.showInformationMessage("✅ Full workspace sync completed!");
  } catch (error) {
    console.error("First time sync failed:", error);
    vscode.window.showErrorMessage(`❌ Full sync failed: ${error.message}`);
  }
}

// Silent attempt: will not prompt
async function tryResolveVSCodeAccountSilent() {
  try {
    console.log("Checking for GitHub account (silent)...");
    const ghSession = await vscode.authentication.getSession("github", [], { createIfNone: false });
    console.log("GitHub session:", ghSession ? "available" : "none");
    if (ghSession?.account?.label) {
      return { email: ghSession.account.label, provider: "github", found: true };
    }
  } catch (e) {
    console.log("GitHub session error:", e?.message || e);
  }

  try {
    console.log("Checking for Microsoft account (silent)...");
    const msSession = await vscode.authentication.getSession("microsoft", [], { createIfNone: false });
    console.log("MS session:", msSession ? "available" : "none");
    if (msSession?.account?.label) {
      return { email: msSession.account.label, provider: "microsoft", found: true };
    }
  } catch (e) {
    console.log("Microsoft session error:", e?.message || e);
  }

  return { found: false };
}

// Interactive attempt: prompts once to grant access
async function tryResolveVSCodeAccountInteractive() {
  try {
    const ghAccounts = await vscode.authentication.getAccounts("github");
    console.log("GitHub accounts:", ghAccounts?.map((a) => a.label));
  } catch (e) {
    console.log("getAccounts(github) error:", e?.message || e);
  }

  try {
    const gh = await vscode.authentication.getSession(
      "github",
      ["read:user", "user:email"],
      { createIfNone: true }
    );
    if (gh?.account?.label) {
      return { email: gh.account.label, provider: "github", found: true };
    }
  } catch (e) {
    console.log("Interactive GitHub session error:", e?.message || e);
  }

  try {
    const msAccounts = await vscode.authentication.getAccounts("microsoft");
    console.log("MS accounts:", msAccounts?.map((a) => a.label));
  } catch (e) {
    console.log("getAccounts(microsoft) error:", e?.message || e);
  }

  try {
    const ms = await vscode.authentication.getSession("microsoft", [], { createIfNone: true });
    if (ms?.account?.label) {
      return { email: ms.account.label, provider: "microsoft", found: true };
    }
  } catch (e) {
    console.log("Interactive Microsoft session error:", e?.message || e);
  }

  return { found: false };
}

// =======================
// Login/Logout Functions  
// =======================

async function logoutUser(context) {
  try {
    const userInfo = context.globalState.get("codesync_user");
    
    if (!userInfo?.active) {
      vscode.window.showInformationMessage("❌ No active user to logout");
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      `Logout from CodeSync?\n\nCurrent user: ${userInfo.email}\n\nThis will stop auto-sync and require re-authentication.`,
      "Yes, Logout",
      "Cancel"
    );

    if (choice === "Yes, Logout") {
      // Clear all user state
      await context.globalState.update("codesync_user", undefined);
      
      // Clear sync flags for this user
      const syncKey = `fullSyncDone_${userInfo.email}`;
      await context.globalState.update(syncKey, undefined);
      
      // Clear any other user-specific data
      const allKeys = context.globalState.keys();
      for (const key of allKeys) {
        if (key.includes(userInfo.email)) {
          await context.globalState.update(key, undefined);
        }
      }

      console.log(`User logged out: ${userInfo.email}`);
      vscode.window.showInformationMessage(
        `✅ Logged out successfully!\n\nCodeSync is now inactive. Use "CodeSync: Login" to sign in again.`
      );
    }
    
  } catch (error) {
    console.error("Logout error:", error);
    vscode.window.showErrorMessage(`❌ Logout failed: ${error.message}`);
  }
}

// =======================
// Status
// =======================

async function showSyncStatus(context) {
  const userInfo = context.globalState.get("codesync_user");
  if (!userInfo?.active) {
    vscode.window.showInformationMessage("❌ CodeSync not active - No VS Code account found.");
    return;
  }
  
  const syncKey = `fullSyncDone_${userInfo.email}`;
  const fullSyncDone = context.globalState.get(syncKey);
  const syncStatus = fullSyncDone ? "✅ Full sync completed" : "⚠️ Pending full sync";
  
  // Show file count from cloud
  try {
    const response = await axios.get(`${BACKEND_BASE_URL}/files/${encodeURIComponent(userInfo.email)}`);
    const fileCount = response.data.count || 0;
    
    vscode.window.showInformationMessage(
      `✅ CodeSync active for ${userInfo.email} (${userInfo.provider})\n${syncStatus}\n📁 Cloud files: ${fileCount}`
    );
  } catch (error) {
    vscode.window.showInformationMessage(
      `✅ CodeSync active for ${userInfo.email} (${userInfo.provider})\n${syncStatus}`
    );
  }
}

// =======================
// Auto sync on save (Manual Ctrl+S + Auto Save)
// =======================

async function autoSyncFile(document, context) {
  const userInfo = context.globalState.get("codesync_user");
  
  // Silent return if no active user (logged out)
  if (!userInfo?.active) {
    console.log("Auto-sync skipped - user logged out");
    return;
  }

  // Rest of your existing code...
  const filePath = document.uri.fsPath;
  const ext = path.extname(filePath).toLowerCase();
  
  if (!INCLUDE_EXTS.includes(ext)) {
    console.log(`Skipping non-relevant file: ${filePath}`);
    return;
  }

  if (autoSyncFile._timer) clearTimeout(autoSyncFile._timer);

  autoSyncFile._timer = setTimeout(async () => {
    try {
      await uploadFileToBackend(filePath, userInfo.email);
      vscode.window.setStatusBarMessage("$(cloud-upload) Synced", 1500);
      console.log(`Auto-synced: ${path.basename(filePath)}`);
    } catch (error) {
      console.error("Auto-sync failed:", error);
      vscode.window.setStatusBarMessage("$(error) Sync failed", 2000);
    }
  }, 300);
}

// =======================
// Manual full workspace sync
// =======================

async function syncEntireWorkspace(context) {
  const userInfo = context.globalState.get("codesync_user");
  if (!userInfo?.active) {
    vscode.window.showErrorMessage("❌ No active user found. Sign in to GitHub/Microsoft in VS Code first.");
    return;
  }

  const wsFolders = vscode.workspace.workspaceFolders;
  if (!wsFolders?.length) {
    vscode.window.showErrorMessage("No workspace folder found.");
    return;
  }

  const workspacePath = wsFolders[0].uri.fsPath;
  const allFiles = collectWorkspaceFiles(workspacePath);

  if (!allFiles.length) {
    vscode.window.showInformationMessage("No files matched your sync filters.");
    return;
  }

  console.log(`Starting full workspace sync: ${allFiles.length} files`);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Syncing workspace...", cancellable: false },
    async (progress) => {
      for (let i = 0; i < allFiles.length; i++) {
        const filePath = allFiles[i];
        progress.report({
          increment: 100 / allFiles.length,
          message: `${i + 1}/${allFiles.length}: ${path.basename(filePath)}`
        });
        try {
          await uploadFileToBackend(filePath, userInfo.email);
        } catch (e) {
          console.error("Failed to upload", filePath, e?.message || e);
        }
      }
    }
  );

  vscode.window.showInformationMessage(`✅ ${allFiles.length} files synced to cloud`);
}

function collectWorkspaceFiles(root) {
  const results = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.some((ex) => entry.name === ex)) continue;
        walk(full);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (INCLUDE_EXTS.includes(ext)) {
          results.push(full);
        }
      }
    }
  }

  walk(root);
  return results;
}

// =======================
// Upload to backend
// =======================

async function uploadFileToBackend(filePath, userEmail) {
  const wsFolders = vscode.workspace.workspaceFolders;
  if (!wsFolders?.length) {
    throw new Error("No workspace folder open.");
  }
  const workspacePath = wsFolders[0].uri.fsPath;

  const formData = new FormData();
  formData.append("file", fs.createReadStream(filePath));
  formData.append("userEmail", userEmail);
  formData.append("relativePath", path.relative(workspacePath, filePath) || path.basename(filePath));

  const url = `${BACKEND_BASE_URL}/upload`;
  const res = await axios.post(url, formData, {
    headers: { ...formData.getHeaders() },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 30000
  });

  if (!res?.data?.ok) {
    throw new Error(res?.data?.error || "Upload failed");
  }

  return res.data;
}

// =======================
// Cross-Device File Restoration
// =======================

async function downloadWorkspaceFromCloud(context, userEmail) {
  try {
    vscode.window.showInformationMessage("📥 Fetching your files from cloud...");

    // Get list of files from backend
    const fileListResponse = await axios.get(`${BACKEND_BASE_URL}/files/${encodeURIComponent(userEmail)}`, {
      timeout: 15000
    });

    const files = fileListResponse.data.files;
    
    if (!files || files.length === 0) {
      vscode.window.showInformationMessage("No files found in cloud for this account.");
      return false;
    }

    console.log(`Found ${files.length} files in cloud for ${userEmail}`);
    console.log("Files to download:");
    files.forEach((file, index) => {
      console.log(`  ${index + 1}. ${file.relativePath}`);
    });

    const wsFolders = vscode.workspace.workspaceFolders;
    if (!wsFolders?.length) {
      vscode.window.showErrorMessage("Please open a workspace folder first.");
      return false;
    }

    const workspacePath = wsFolders[0].uri.fsPath;

    // Download files with progress
    await vscode.window.withProgress(
      { 
        location: vscode.ProgressLocation.Notification, 
        title: "Downloading workspace files...", 
        cancellable: false 
      },
      async (progress) => {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          progress.report({
            increment: 100 / files.length,
            message: `${i + 1}/${files.length}: ${file.name || path.basename(file.relativePath)}`
          });

          try {
            await downloadSingleFile(userEmail, file.relativePath, workspacePath);
          } catch (error) {
            console.error(`Failed to download ${file.relativePath}:`, error);
          }
        }
      }
    );

    vscode.window.showInformationMessage(`✅ ${files.length} files restored to workspace!`);
    return true;

  } catch (error) {
    console.error("Download workspace failed:", error);
    vscode.window.showErrorMessage(`❌ Failed to fetch files: ${error.message}`);
    return false;
  }
}

async function downloadSingleFile(userEmail, relativePath, workspacePath) {
  try {
    console.log(`Attempting to download: ${relativePath}`);
    
    // Changed to POST method with body data to avoid path-to-regexp issues
    const response = await axios.post(
      `${BACKEND_BASE_URL}/download`,
      {
        userEmail: userEmail,
        filePath: relativePath
      },
      { timeout: 10000 }
    );

    const { content } = response.data;
    const localFilePath = path.join(workspacePath, relativePath);

    // Create directory structure if needed
    const dir = path.dirname(localFilePath);
    console.log(`Creating directory if needed: ${dir}`);
    
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`✅ Directory created: ${dir}`);
    }

    // Write file content
    fs.writeFileSync(localFilePath, content, 'utf8');
    console.log(`✅ Downloaded: ${relativePath}`);

  } catch (error) {
    console.error(`❌ Download error for ${relativePath}:`, error.message);
    
    // Enhanced error logging for debugging
    if (error.response) {
      console.error(`HTTP Status: ${error.response.status}`);
      console.error(`Response: ${JSON.stringify(error.response.data)}`);
    }
    
    // Log the exact path being attempted
    const localFilePath = path.join(workspacePath, relativePath);
    console.error(`Attempted local path: ${localFilePath}`);
    
    throw error;
  }
}

// Check if workspace is empty (new device scenario)
function isWorkspaceEmpty(workspacePath) {
  try {
    const items = fs.readdirSync(workspacePath);
    // Consider workspace empty if only has .vscode, .git, or other config files
    const relevantItems = items.filter(item => 
      !item.startsWith('.') && 
      !EXCLUDE_DIRS.includes(item)
    );
    return relevantItems.length === 0;
  } catch {
    return true;
  }
}

module.exports = { activate, deactivate };
