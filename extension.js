const vscode = require("vscode");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");

// =======================
// Configuration
// =======================

const BACKEND_BASE_URL = "https://codesync-backend-lqy1.onrender.com";

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

  // ===== NEW: UNIFIED DOWNLOAD COMMAND =====
  const downloadFilesCmd = vscode.commands.registerCommand("code-sync.downloadFiles", async () => {
    const userInfo = context.globalState.get("codesync_user");
    if (!userInfo?.active) {
      vscode.window.showErrorMessage("❌ Please login first");
      return;
    }
    
    console.log("Download Files command triggered");
    await showDownloadOptions(context, userInfo.email);
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

  // Register ALL commands properly
  context.subscriptions.push(statusCmd, syncAllCmd, debugAuthCmd, debugAuthInteractiveCmd, loginCmd, logoutCmd, downloadFilesCmd, debugFilesCmd);
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
        "Yes, Browse & Select",
        "No, Start Fresh",
        "Later"
      );

      if (choice === "Yes, Browse & Select") {
        console.log("User chose to browse and select files");
        // Call the unified download options
        const restored = await showDownloadOptions(context, userEmail);
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
// NEW: UNIFIED DOWNLOAD OPTIONS
// =======================

// Replace showDownloadOptions function with this simplified version:
async function showDownloadOptions(context, userEmail) {
  try {
    console.log("Showing simplified download options for:", userEmail);
    
    // Show simplified download options
    const downloadChoice = await vscode.window.showQuickPick([
      {
        label: "📥 Download All Files",
        description: "Download all files from all workspaces",
        detail: "Quick download of everything in your cloud storage",
        action: "all"
      },
      {
        label: "📁 Browse & Select Files",
        description: "Choose workspace and select specific files",
        detail: "Browse workspaces and pick exactly what you need",
        action: "browse"
      }
    ], {
      placeHolder: "Choose download method",
      title: "CodeSync: Download Files"
    });

    if (!downloadChoice) {
      vscode.window.showInformationMessage("Download cancelled.");
      return false;
    }

    console.log("User selected download method:", downloadChoice.action);

    switch (downloadChoice.action) {
      case "all":
        return await downloadAllFilesFromAllWorkspaces(context, userEmail);
      case "browse":
        return await browseAndSelectFiles(context, userEmail);
      default:
        return false;
    }

  } catch (error) {
    console.error("Show download options failed:", error);
    vscode.window.showErrorMessage(`❌ Failed to show download options: ${error.message}`);
    return false;
  }
}

// New combined function for browsing and selecting
async function browseAndSelectFiles(context, userEmail) {
  try {
    console.log("Starting browse and select files");
    vscode.window.showInformationMessage("📋 Loading your workspaces...");

    // Get all workspaces
    const workspacesResponse = await axios.get(`${BACKEND_BASE_URL}/workspaces/${encodeURIComponent(userEmail)}`, {
      timeout: 15000
    });

    const workspaces = workspacesResponse.data.workspaces;
    
    if (!workspaces || workspaces.length === 0) {
      vscode.window.showInformationMessage("No workspaces found in cloud for this account.");
      return false;
    }

    console.log(`Found ${workspaces.length} workspaces`);

    // Let user select workspace
    const workspaceOptions = workspaces.map(ws => ({
      label: `📁 ${ws.name}`,
      description: `${ws.fileCount} files • ${ws.sizeMB} MB`,
      detail: `Last modified: ${new Date(ws.lastModified).toLocaleDateString()}`,
      workspace: ws
    }));

    const selectedWorkspace = await vscode.window.showQuickPick(workspaceOptions, {
      placeHolder: `Select workspace to browse (${workspaces.length} available)`,
      title: "CodeSync: Choose Workspace"
    });

    if (!selectedWorkspace) {
      vscode.window.showInformationMessage("No workspace selected.");
      return false;
    }

    console.log(`User selected workspace: ${selectedWorkspace.workspace.name}`);

    // Ask what to download from this workspace
    const downloadOption = await vscode.window.showQuickPick([
      {
        label: "📥 Download All Files from This Workspace",
        description: `Download all ${selectedWorkspace.workspace.fileCount} files`,
        detail: "Complete workspace download",
        action: "all"
      },
      {
        label: "🎯 Select Specific Files",
        description: "Choose exactly which files to download",
        detail: "Pick individual files from this workspace",
        action: "select"
      }
    ], {
      placeHolder: "What do you want to download?",
      title: `From workspace: ${selectedWorkspace.workspace.name}`
    });

    if (!downloadOption) {
      vscode.window.showInformationMessage("Download cancelled.");
      return false;
    }

    console.log("User selected workspace download action:", downloadOption.action);

    if (downloadOption.action === "all") {
      return await downloadAllWorkspaceFiles(context, userEmail, selectedWorkspace.workspace.name);
    } else {
      return await selectiveDownloadFromWorkspace(context, userEmail, selectedWorkspace.workspace.name);
    }

  } catch (error) {
    console.error("Browse and select files failed:", error);
    vscode.window.showErrorMessage(`❌ Failed to browse files: ${error.message}`);
    return false;
  }
}


// =======================
// DOWNLOAD METHOD 1: Download All Files from All Workspaces
// =======================

async function downloadAllFilesFromAllWorkspaces(context, userEmail) {
  try {
    console.log("Downloading all files from all workspaces");
    vscode.window.showInformationMessage("📥 Downloading all your files from cloud...");

    // Get all files using legacy endpoint
    const fileListResponse = await axios.get(`${BACKEND_BASE_URL}/files/${encodeURIComponent(userEmail)}`, {
      timeout: 15000
    });

    const files = fileListResponse.data.files;
    
    if (!files || files.length === 0) {
      vscode.window.showInformationMessage("No files found in cloud for this account.");
      return false;
    }

    console.log(`Found ${files.length} files total across all workspaces`);

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
        title: "Downloading all files...", 
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

    vscode.window.showInformationMessage(`✅ Downloaded all ${files.length} files from cloud!`);
    return true;

  } catch (error) {
    console.error("Download all files failed:", error);
    vscode.window.showErrorMessage(`❌ Failed to download all files: ${error.message}`);
    return false;
  }
}

// =======================
// DOWNLOAD METHOD 2: Selective Workspace and File Download
// =======================

async function selectiveWorkspaceAndFileDownload(context, userEmail) {
  try {
    console.log("Starting selective workspace and file download");
    vscode.window.showInformationMessage("📋 Loading your workspaces...");

    // Get all workspaces
    const workspacesResponse = await axios.get(`${BACKEND_BASE_URL}/workspaces/${encodeURIComponent(userEmail)}`, {
      timeout: 15000
    });

    const workspaces = workspacesResponse.data.workspaces;
    
    if (!workspaces || workspaces.length === 0) {
      vscode.window.showInformationMessage("No workspaces found in cloud for this account.");
      return false;
    }

    console.log(`Found ${workspaces.length} workspaces`);

    // Let user select workspace
    const workspaceOptions = workspaces.map(ws => ({
      label: `📁 ${ws.name}`,
      description: `${ws.fileCount} files • ${ws.sizeMB} MB`,
      detail: `Last modified: ${new Date(ws.lastModified).toLocaleDateString()}`,
      workspace: ws
    }));

    const selectedWorkspace = await vscode.window.showQuickPick(workspaceOptions, {
      placeHolder: `Select workspace to browse (${workspaces.length} workspaces available)`,
      title: "CodeSync: Choose Workspace for File Selection"
    });

    if (!selectedWorkspace) {
      vscode.window.showInformationMessage("No workspace selected.");
      return false;
    }

    console.log(`User selected workspace: ${selectedWorkspace.workspace.name}`);

    // Get files in selected workspace
    const response = await axios.get(`${BACKEND_BASE_URL}/workspace/${encodeURIComponent(userEmail)}/${encodeURIComponent(selectedWorkspace.workspace.name)}`, {
      timeout: 15000
    });

    const { files, count } = response.data;
    
    if (!files || files.length === 0) {
      vscode.window.showInformationMessage(`No files found in workspace "${selectedWorkspace.workspace.name}".`);
      return false;
    }

    console.log(`Found ${files.length} files in workspace ${selectedWorkspace.workspace.name}`);

    // Create file selection options organized by folder
    const fileOptions = files.map(file => {
      const folderPath = path.dirname(file.relativePath);
      const displayFolder = folderPath === '.' ? 'root' : folderPath;
      
      return {
        label: path.basename(file.relativePath),
        description: `${file.sizeMB} MB • 📁 ${displayFolder}`,
        detail: `Last modified: ${new Date(file.lastModified).toLocaleString()}`,
        picked: false,
        file: file
      };
    }).sort((a, b) => a.description.localeCompare(b.description));

    // Show multi-select file picker
    const selectedOptions = await vscode.window.showQuickPick(fileOptions, {
      canPickMany: true,
      placeHolder: `Select files to download from "${selectedWorkspace.workspace.name}" (${count} files available)`,
      title: `CodeSync: Select Files from ${selectedWorkspace.workspace.name}`
    });

    if (!selectedOptions || selectedOptions.length === 0) {
      vscode.window.showInformationMessage("No files selected for download.");
      return false;
    }

    const selectedFilePaths = selectedOptions.map(option => option.file.relativePath);
    
    console.log(`User selected ${selectedFilePaths.length} files from ${selectedWorkspace.workspace.name}`);

    // Download selected files
    const downloadResponse = await axios.post(`${BACKEND_BASE_URL}/download-workspace-files`, {
      userEmail: userEmail,
      workspaceName: selectedWorkspace.workspace.name,
      selectedFiles: selectedFilePaths,
      downloadAll: false
    }, { timeout: 30000 });

    const downloadedFiles = downloadResponse.data.files;
    
    await writeDownloadedFiles(downloadedFiles, selectedWorkspace.workspace.name);

    vscode.window.showInformationMessage(
      `✅ Downloaded ${downloadedFiles.length} selected files from workspace "${selectedWorkspace.workspace.name}"!`
    );
    return true;

  } catch (error) {
    console.error("Selective workspace and file download failed:", error);
    vscode.window.showErrorMessage(`❌ Failed to download selected files: ${error.message}`);
    return false;
  }
}

// =======================
// DOWNLOAD METHOD 3: Workspace-Based Download
// =======================

async function workspaceBasedDownload(context, userEmail) {
  try {
    console.log("Starting workspace-based download");
    vscode.window.showInformationMessage("📋 Loading your workspaces from cloud...");

    // Get all workspaces
    const workspacesResponse = await axios.get(`${BACKEND_BASE_URL}/workspaces/${encodeURIComponent(userEmail)}`, {
      timeout: 15000
    });

    const workspaces = workspacesResponse.data.workspaces;
    
    if (!workspaces || workspaces.length === 0) {
      vscode.window.showInformationMessage("No workspaces found in cloud for this account.");
      return false;
    }

    console.log(`Found ${workspaces.length} workspaces`);

    // Let user select workspace
    const workspaceOptions = workspaces.map(ws => ({
      label: `📁 ${ws.name}`,
      description: `${ws.fileCount} files • ${ws.sizeMB} MB • ${new Date(ws.lastModified).toLocaleDateString()}`,
      detail: `Last modified: ${new Date(ws.lastModified).toLocaleString()}`,
      workspace: ws
    }));

    const selectedWorkspace = await vscode.window.showQuickPick(workspaceOptions, {
      placeHolder: `Select workspace to download (${workspaces.length} workspaces available)`,
      title: "CodeSync: Choose Workspace"
    });

    if (!selectedWorkspace) {
      vscode.window.showInformationMessage("No workspace selected.");
      return false;
    }

    console.log(`User selected workspace: ${selectedWorkspace.workspace.name}`);

    // Ask for download preference for this workspace
    const downloadOption = await vscode.window.showQuickPick([
      {
        label: "📥 Download All Files from Workspace",
        description: `Download all ${selectedWorkspace.workspace.fileCount} files from "${selectedWorkspace.workspace.name}"`,
        detail: "Complete workspace download",
        action: "all"
      },
      {
        label: "🎯 Select Specific Files from Workspace",
        description: "Choose exactly which files to download from this workspace",
        detail: "Selective download within workspace",
        action: "select"
      }
    ], {
      placeHolder: "Choose download option for this workspace",
      title: `Download from workspace: ${selectedWorkspace.workspace.name}`
    });

    if (!downloadOption) {
      vscode.window.showInformationMessage("Download cancelled.");
      return false;
    }

    console.log("User selected workspace download action:", downloadOption.action);

    if (downloadOption.action === "all") {
      return await downloadAllWorkspaceFiles(context, userEmail, selectedWorkspace.workspace.name);
    } else {
      return await selectiveDownloadFromWorkspace(context, userEmail, selectedWorkspace.workspace.name);
    }

  } catch (error) {
    console.error("Workspace-based download failed:", error);
    vscode.window.showErrorMessage(`❌ Failed to load workspaces: ${error.message}`);
    return false;
  }
}

// =======================
// Helper Functions for Downloads
// =======================

async function downloadAllWorkspaceFiles(context, userEmail, workspaceName) {
  try {
    console.log(`📥 Downloading all files from workspace: ${workspaceName}`);

    const response = await axios.post(`${BACKEND_BASE_URL}/download-workspace-files`, {
      userEmail: userEmail,
      workspaceName: workspaceName,
      downloadAll: true
    }, { timeout: 60000 });

    const downloadedFiles = response.data.files;
    
    if (!downloadedFiles || downloadedFiles.length === 0) {
      vscode.window.showInformationMessage("No files found in this workspace.");
      return false;
    }

    await writeDownloadedFiles(downloadedFiles, workspaceName);

    vscode.window.showInformationMessage(
      `✅ Downloaded all ${downloadedFiles.length} files from workspace "${workspaceName}"!`
    );
    return true;

  } catch (error) {
    console.error("Download all workspace files failed:", error);
    vscode.window.showErrorMessage(`❌ Failed to download workspace: ${error.message}`);
    return false;
  }
}

async function selectiveDownloadFromWorkspace(context, userEmail, workspaceName) {
  try {
    vscode.window.showInformationMessage("📋 Loading workspace files...");

    // Get files in this workspace
    const response = await axios.get(`${BACKEND_BASE_URL}/workspace/${encodeURIComponent(userEmail)}/${encodeURIComponent(workspaceName)}`, {
      timeout: 15000
    });

    const { files, count } = response.data;
    
    if (!files || files.length === 0) {
      vscode.window.showInformationMessage(`No files found in workspace "${workspaceName}".`);
      return false;
    }

    console.log(`Found ${files.length} files in workspace ${workspaceName}`);

    // Create selection options with better organization
    const fileOptions = files.map(file => {
      const folderPath = path.dirname(file.relativePath);
      const displayFolder = folderPath === '.' ? 'root' : folderPath;
      
      return {
        label: path.basename(file.relativePath),
        description: `${file.sizeMB} MB • 📁 ${displayFolder}`,
        detail: `Last modified: ${new Date(file.lastModified).toLocaleString()}`,
        picked: false,
        file: file
      };
    }).sort((a, b) => a.description.localeCompare(b.description));

    // Show multi-select quick pick
    const selectedOptions = await vscode.window.showQuickPick(fileOptions, {
      canPickMany: true,
      placeHolder: `Select files from "${workspaceName}" (${count} files available)`,
      title: `CodeSync: Select Files from ${workspaceName}`
    });

    if (!selectedOptions || selectedOptions.length === 0) {
      vscode.window.showInformationMessage("No files selected for download.");
      return false;
    }

    const selectedFilePaths = selectedOptions.map(option => option.file.relativePath);
    
    console.log(`User selected ${selectedFilePaths.length} files from ${workspaceName}`);

    // Download selected files
    const downloadResponse = await axios.post(`${BACKEND_BASE_URL}/download-workspace-files`, {
      userEmail: userEmail,
      workspaceName: workspaceName,
      selectedFiles: selectedFilePaths,
      downloadAll: false
    }, { timeout: 30000 });

    const downloadedFiles = downloadResponse.data.files;
    
    await writeDownloadedFiles(downloadedFiles, workspaceName);

    vscode.window.showInformationMessage(
      `✅ Downloaded ${downloadedFiles.length} selected files from workspace "${workspaceName}"!`
    );
    return true;

  } catch (error) {
    console.error("Selective workspace download failed:", error);
    vscode.window.showErrorMessage(`❌ Failed to download files: ${error.message}`);
    return false;
  }
}

async function writeDownloadedFiles(downloadedFiles, workspaceName) {
  const wsFolders = vscode.workspace.workspaceFolders;
  if (!wsFolders?.length) {
    vscode.window.showErrorMessage("Please open a workspace folder first.");
    return;
  }

  const workspacePath = wsFolders[0].uri.fsPath;

  // Write files with progress
  await vscode.window.withProgress(
    { 
      location: vscode.ProgressLocation.Notification, 
      title: `Writing files from "${workspaceName}"...`, 
      cancellable: false 
    },
    async (progress) => {
      for (let i = 0; i < downloadedFiles.length; i++) {
        const file = downloadedFiles[i];
        progress.report({
          increment: 100 / downloadedFiles.length,
          message: `${i + 1}/${downloadedFiles.length}: ${path.basename(file.filePath)}`
        });

        try {
          const localFilePath = path.join(workspacePath, file.filePath);
          
          // Create directory structure if needed
          const dir = path.dirname(localFilePath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            console.log(`📁 Created directory: ${dir}`);
          }

          // Write file content
          fs.writeFileSync(localFilePath, file.content, 'utf8');
          console.log(`✅ Created: ${file.filePath}`);
          
        } catch (error) {
          console.error(`Failed to write ${file.filePath}:`, error);
        }
      }
    }
  );
}

async function downloadSingleFile(userEmail, relativePath, workspacePath) {
  try {
    console.log(`Attempting to download: ${relativePath}`);
    
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
    
    if (error.response) {
      console.error(`HTTP Status: ${error.response.status}`);
      console.error(`Response: ${JSON.stringify(error.response.data)}`);
    }
    
    const localFilePath = path.join(workspacePath, relativePath);
    console.error(`Attempted local path: ${localFilePath}`);
    
    throw error;
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
  
  try {
    const response = await axios.get(`${BACKEND_BASE_URL}/workspaces/${encodeURIComponent(userInfo.email)}`);
    const workspaces = response.data.workspaces || [];
    const totalFiles = workspaces.reduce((sum, ws) => sum + ws.fileCount, 0);
    const totalSize = workspaces.reduce((sum, ws) => sum + parseFloat(ws.sizeMB), 0);
    
    vscode.window.showInformationMessage(
      `✅ CodeSync active for ${userInfo.email} (${userInfo.provider})\n${syncStatus}\n📁 Workspaces: ${workspaces.length}\n📄 Total files: ${totalFiles}\n💾 Storage used: ${totalSize.toFixed(2)} MB\n🧹 Auto-cleanup: Every 3 weeks`
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
// Upload to backend with workspace detection
// =======================

async function uploadFileToBackend(filePath, userEmail) {
  const wsFolders = vscode.workspace.workspaceFolders;
  if (!wsFolders?.length) {
    throw new Error("No workspace folder open.");
  }
  const workspacePath = wsFolders[0].uri.fsPath;
  const workspaceName = path.basename(workspacePath); // Get workspace folder name

  const formData = new FormData();
  formData.append("file", fs.createReadStream(filePath));
  formData.append("userEmail", userEmail);
  formData.append("workspaceName", workspaceName); // Include workspace name
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
