'use strict';
// Isolated Electron acceptance. Instrument only the served test copy, never the
// product bundle, user profile, provider credentials, or a real saved canvas.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{Readable}=require('node:stream');
const root=path.resolve(__dirname,'..'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'penecho-navigation-'));
app.setPath('userData',path.join(directory,'profile'));
Object.assign(process.env,{NODE_ENV:'test',PENECHO_TEST_OPEN_ACCESS:'1',PENECHO_STATE_DIR:path.join(directory,'state'),HOST:'127.0.0.1',PORT:'0',AI_PROVIDER:'api',AI_API_KEY:'navigation-test',AI_API_URL:'http://127.0.0.1:1/v1',AI_API_MODEL:'test',PENECHO_CANVAS_AGENT_AUTO_OPEN:'false',PENECHO_REQUEST_TRACE:'false'});
const readStream=fs.createReadStream;
fs.createReadStream=function(file,...args){
 if(path.resolve(String(file))===path.join(root,'public/app.js')){
  const code=fs.readFileSync(file,'utf8').replace(/\}\)\(\);\s*$/,`window.navigationTest={enterWidgetInteraction,serializedWidgets,cancelWidgetEdit,showHandObjectToolbar,fitWidgetToContent,beginWidgetEdit,state,restoreWidgets,render,setCanvasMode,setCanvasViewMode,setCanvasViewTool,setWidgetInteraction,positionWidgets,syncCanvasNavigation,finishCanvasNavigationPreview,handleCanvasWheel,fitCanvasContents,zoomCanvasAt};})();`);
  return Readable.from([code]);
 }
 return readStream.call(this,file,...args);
};
let server,win;
const report={directory,checks:[],errors:[]};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,label){for(let i=0;i<100;i++){if(await check())return;await pause(100);}throw Error('Timed out: '+label);}
app.whenReady().then(async()=>{try{
 server=require('../server.js');await new Promise(r=>server.listening?r():server.once('listening',r));
 win=new BrowserWindow({show:true,width:1200,height:900,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:false}});
 win.webContents.on('console-message',(_e,level,message)=>{if(level>=3){report.errors.push(message);console.error(message);}});
 await win.loadURL(`http://127.0.0.1:${server.address().port}`);
 const js=async code=>{try{return await win.webContents.executeJavaScript(code,true)}catch(e){console.error(code);throw e;}};
 await until(()=>js('!!window.navigationTest'),'application startup');
 await js(`document.querySelector('#tourSkip')?.click();document.querySelector('#changelogClose')?.click();document.querySelector('#studioNavigatorToggle')?.click();if(document.querySelector('#auto').getAttribute('aria-pressed')==='true')document.querySelector('#auto').click();`);
 const camera=()=>js('(()=>{const s=navigationTest.state;return {x:s.panX,y:s.panY,scale:s.scale};})()');


 const fixtures = [
  {name:'fixed',html:'<body style="margin:0"><div style="width:900px;height:1100px;background:#ddd">Fit content</div></body>'},
  {name:'nested',html:'<body style="margin:0"><main style="width:100%;height:100vh;overflow:auto"><header style="height:60px">Header</header><section style="height:300px;max-height:300px;overflow:auto"><div style="width:900px;height:1100px;background:#ddd">Nested scroll content</div></section><footer style="height:40px">Footer</footer></main></body>'},
  {name:'flex',html:'<body style="margin:0;height:100vh;display:flex;flex-direction:column;overflow:auto"><header style="height:60px;flex-shrink:0">Header</header><main style="flex:1;min-height:0;overflow:auto"><div style="width:900px;height:1100px;background:#ddd">Flex scroll content</div></main><footer style="height:40px;flex-shrink:0">Footer</footer></body>'}
 ];
 let result;
 for(const fixture of fixtures){
 await js(`(()=>{const n=navigationTest,s=n.state;n.setCanvasMode('select');s.scale=.6;s.panX=30;s.panY=60;n.restoreWidgets(${JSON.stringify([{id:'widget-1',pluginId:'general',widgetType:'html_widget',x:80,y:80,w:300,h:250,contentW:600,contentH:500,title:fixture.name,refreshSeconds:0,html:fixture.html}])});n.render();})()`);
 await until(()=>js('navigationTest.state.widgets[0]?.contentVersion>0'),'widget ready');
 await pause(700);
 await js("document.querySelector('#changelogClose')?.click();Object.assign(navigationTest.state,{scale:.6,panX:30,panY:60});navigationTest.showHandObjectToolbar('widget',navigationTest.state.widgets[0]);navigationTest.render();");
 await until(()=>js("!![...document.querySelectorAll('.object-chrome-button')].find(b=>b.getAttribute('aria-label')==='Fit to content'&&!b.hidden)"),'fit toolbar');
 await js('window.fitFrame=navigationTest.state.widgets[0].frame');
 await js(`[...document.querySelectorAll('.object-chrome-button')].find(b=>b.getAttribute('aria-label')==='Fit to content').click()`);
 await until(()=>js('!navigationTest.state.widgets[0].fitContentBusy'),'fit completed');
 const inner=win.webContents.mainFrame.framesInSubtree.find(f=>f.url==='about:srcdoc' && f.parent?.url.includes('parent-origin='));
 const overflow=await inner.executeJavaScript(`(()=>{const r=document.documentElement;return {rootX:r.scrollWidth-innerWidth,rootY:r.scrollHeight-innerHeight,scrolling:[...document.querySelectorAll('body *')].filter(e=>{const s=getComputedStyle(e);return (/auto|scroll/.test(s.overflowY)&&e.scrollHeight>e.clientHeight+1)||(/auto|scroll/.test(s.overflowX)&&e.scrollWidth>e.clientWidth+1)}).map(e=>e.tagName)};})()`);
 assert(overflow.rootX<=1,JSON.stringify({fixture:fixture.name,overflow}));
 assert(overflow.rootY<=1,JSON.stringify({fixture:fixture.name,overflow}));
 assert.deepEqual(overflow.scrolling,[],fixture.name);
 result=await js('(()=>{const w=navigationTest.state.widgets[0];return {contentW:w.contentW,contentH:w.contentH,w:w.w,h:w.h,x:w.x,y:w.y,same:w.frame===fitFrame,fitContent:w.fitContent,changed:navigationTest.state.widgetEdit.changed};})()');
 assert(result.contentW>=900);assert(result.contentH>=1100);assert.equal(result.w/result.contentW,.5);assert.equal(result.h/result.contentH,.5);assert(result.same);assert(result.changed);assert(result.fitContent);
 await js('navigationTest.fitWidgetToContent(navigationTest.state.widgets[0])');
 assert.equal(await js('navigationTest.state.widgets[0].contentH'),result.contentH);
 assert.equal(await js('navigationTest.serializedWidgets()[0].fitContent'),true);
 report.checks.push({name:fixture.name,result,overflow});
 await js("navigationTest.cancelWidgetEdit();navigationTest.showHandObjectToolbar('widget',navigationTest.state.widgets[0]);navigationTest.render();");
 const cancelledInner=win.webContents.mainFrame.framesInSubtree.find(f=>f.url==='about:srcdoc' && f.parent?.url.includes('parent-origin='));
 await until(()=>cancelledInner.executeJavaScript('innerWidth===600&&innerHeight===500'),'cancelled viewport');
 if(fixture.name!=='fixed') await until(()=>cancelledInner.executeJavaScript("[...document.querySelectorAll('body,body *')].some(e=>/auto|scroll/.test(getComputedStyle(e).overflowY)&&e.scrollHeight>e.clientHeight+1)"),'cancel restores scroll policy '+fixture.name);
 await js('navigationTest.fitWidgetToContent(navigationTest.state.widgets[0])');
 await js('window.savedFit=navigationTest.serializedWidgets();navigationTest.restoreWidgets(window.savedFit)');
 await until(()=>js('navigationTest.state.widgets[0]?.contentVersion>0'),'restored widget ready');
 await js("navigationTest.showHandObjectToolbar('widget',navigationTest.state.widgets[0]);navigationTest.render();");
 const restored=win.webContents.mainFrame.framesInSubtree.find(f=>f.url==='about:srcdoc' && f.parent?.url.includes('parent-origin='));
 await until(()=>restored.executeJavaScript('document.documentElement.scrollHeight<=innerHeight+1&&document.documentElement.scrollWidth<=innerWidth+1'),'restored fit '+fixture.name);
 assert.equal(await js('navigationTest.state.widgets[0].fitContent'),true);

 }
 // The same outside-canvas pointer route used by the user must restore Hand.
 await js("navigationTest.setCanvasMode('hand');navigationTest.state.widgets[0].shell.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,button:0}))");
 assert.equal(await js('navigationTest.state.mode'),'select');
 win.webContents.debugger.attach('1.3');
 for(const type of ['mousePressed','mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:1000,y:700,button:'left',clickCount:1});
 assert.equal(await js('navigationTest.state.mode'),'hand');
 assert.equal(await js('navigationTest.state.interactingWidgetId'),null);
 report.checks.push({name:'outside click restores hand'});
 for(const narrow of [false,true]){win.setSize(narrow?650:1200,900);await js(`navigationTest.showHandObjectToolbar('widget',navigationTest.state.widgets[0]);navigationTest.render();`);await pause(350);fs.writeFileSync(path.join(directory,narrow?'narrow.png':'wide.png'),(await win.webContents.capturePage()).toPNG());}
 console.log(JSON.stringify({...report,passed:true}));
 }catch(error){console.error(error);process.exitCode=1;}finally{server?.close();win?.destroy();app.quit();}});
