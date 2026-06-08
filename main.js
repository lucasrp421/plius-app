const { app, BrowserWindow, ipcMain, screen, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

app.disableHardwareAcceleration();

let mainWindow;
let tray;

const configPath = path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try { if(fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath,'utf8')); } catch(e){}
  return {};
}
function saveConfig(data) {
  try { fs.writeFileSync(configPath, JSON.stringify(data,null,2)); } catch(e){}
}

// API call to server
function apiCall(method, endpoint, body) {
  const cfg = loadConfig();
  const serverUrl = cfg.serverUrl || 'http://localhost:3000';
  const url = new URL(serverUrl + endpoint);
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = lib.request({
      hostname: url.hostname, port: url.port || (isHttps?443:80),
      path: url.pathname + url.search, method,
      headers: {'Content-Type':'application/json',...(bodyStr?{'Content-Length':Buffer.byteLength(bodyStr)}:{})}
    }, res => {
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{ try{resolve(JSON.parse(d));}catch(e){resolve({});} });
    });
    req.on('error',reject);
    if(bodyStr) req.write(bodyStr);
    req.end();
  });
}

function createWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const cfg = loadConfig();
  const winW=320, winH=520;
  const x = cfg.posX ?? sw-winW-20;
  const y = cfg.posY ?? sh-winH-20;

  mainWindow = new BrowserWindow({
    width:winW, height:winH, x, y,
    frame:false, transparent:true, alwaysOnTop:false,
    skipTaskbar:true, resizable:true,
    minWidth:280, minHeight:350, maxWidth:480, maxHeight:800,
    webPreferences:{ nodeIntegration:true, contextIsolation:false },
    show:false,
  });
  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', ()=>mainWindow.show());
  mainWindow.on('moved', ()=>{ const[x,y]=mainWindow.getPosition(); const c=loadConfig(); c.posX=x;c.posY=y; saveConfig(c); });
  mainWindow.on('resize', ()=>{ const[w,h]=mainWindow.getSize(); const c=loadConfig(); c.sizeW=w;c.sizeH=h; saveConfig(c); mainWindow.webContents.send('window-resized',{w,h}); });
  if(cfg.sizeW) mainWindow.setSize(cfg.sizeW, cfg.sizeH);
}

function createTray() {
  tray = new Tray(path.join(__dirname,'icon.png'));
  tray.setToolTip('Plius Widget');
  const menu = Menu.buildFromTemplate([
    {label:'Mostrar/Ocultar', click:()=>mainWindow.isVisible()?mainWindow.hide():mainWindow.show()},
    {type:'separator'},
    {label:'Fechar', click:()=>app.quit()}
  ]);
  tray.setContextMenu(menu);
  tray.on('click',()=>mainWindow.isVisible()?mainWindow.hide():mainWindow.show());
}

// IPC — all data goes through server
ipcMain.handle('api-get', async (e, endpoint) => {
  try { return await apiCall('GET', endpoint, null); }
  catch(err){ return {error:err.message}; }
});
ipcMain.handle('api-post', async (e, endpoint, body) => {
  try { return await apiCall('POST', endpoint, body); }
  catch(err){ return {error:err.message}; }
});
ipcMain.handle('api-patch', async (e, endpoint, body) => {
  try { return await apiCall('PATCH', endpoint, body); }
  catch(err){ return {error:err.message}; }
});
ipcMain.handle('api-delete', async (e, endpoint) => {
  try { return await apiCall('DELETE', endpoint, null); }
  catch(err){ return {error:err.message}; }
});
ipcMain.handle('load-config', () => { const c=loadConfig(); return {serverUrl:c.serverUrl||'',hasServer:!!c.serverUrl}; });
ipcMain.handle('save-config', (e,data) => { const c=loadConfig(); Object.assign(c,data); saveConfig(c); return true; });
ipcMain.on('minimize-window', ()=>mainWindow.hide());
ipcMain.on('close-window', ()=>app.quit());
ipcMain.on('set-always-on-top', (e,v)=>mainWindow.setAlwaysOnTop(v));

app.whenReady().then(()=>{
  createWindow();
  try{ createTray(); }catch(e){}
  app.setLoginItemSettings({openAtLogin:true,path:process.execPath,args:['--autostart']});
});
app.on('window-all-closed',()=>{});
app.on('activate',()=>{ if(!mainWindow||mainWindow.isDestroyed()) createWindow(); });
