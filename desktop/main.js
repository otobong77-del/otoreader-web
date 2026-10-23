// OtoReader for the desktop: a window around the published web version, so every update to the
// page reaches the desktop at once and sign-in, library and reading positions stay shared with the phone.
const { app, BrowserWindow, shell, session } = require('electron');
const path = require('path');

const PAGE = 'https://otobong77-del.github.io/otoreader-web/';
// Google refuses to sign in inside anything that calls itself Electron; present as the Chrome it is built on.
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + process.versions.chrome + ' Safari/537.36';

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 480,
    minHeight: 500,
    backgroundColor: '#04191F',
    title: 'OtoReader',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    // backgroundThrottling off: the page's hourly Google renewal and its sync checks keep running while minimised
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, preload: path.join(__dirname, 'preload.js') },
  });
  win.webContents.setUserAgent(CHROME_UA);
  // Google's sign-in opens a small popup window and talks back to the page: allow it, same user agent.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/(accounts\.google\.com|.*\.googleusercontent\.com|.*\.google\.com)\//.test(url)) {
      // opened hidden: the hourly renewal closes it by itself in a moment; one that needs the person (a sign-in,
      // a consent screen, an account question) is still open after two seconds and is shown then
      return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 680, show: false, autoHideMenuBar: true, parent: win, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } } };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-create-window', (child) => {
    child.webContents.setUserAgent(CHROME_UA);
    setTimeout(() => { if (!child.isDestroyed() && !child.isVisible()) child.show(); }, 2000);
  });
  win.loadURL(PAGE);
  win.on('page-title-updated', (e) => { e.preventDefault(); });
}

app.whenReady().then(() => {
  session.defaultSession.setUserAgent(CHROME_UA);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { app.quit(); });
