// Tells the page it runs inside the desktop app, where Google's sign-in window opens without a click,
// so the page renews its Google token on a timer even while minimised. Nothing else is exposed.
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('otoDesktop', { desktop: true, version: '1.1.0' });
