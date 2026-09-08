"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),vm=require("node:vm");
const source=fs.readFileSync(require("node:path").join(__dirname,"../src/client/app/persistence.js"),"utf8");
function extract(name){const start=source.indexOf(`function ${name}(`);let depth=0;for(let i=source.indexOf("{",start);i<source.length;i++){if(source[i]==="{")depth++;else if(source[i]==="}"&&--depth===0)return (source.slice(start-6,start)==="async "?"async ":"")+source.slice(start,i+1);}throw Error(name);}
function setup({dirty=true,saveResult=true,saveError=false,copy=false}={}){
 const calls=[],dialog={open:false,showModal(){this.open=true;calls.push("dialog");},close(){this.open=false;calls.push("dismiss");}},input={value:""};
 let current="original";
 const context=vm.createContext({pendingCanvasTransition:null,state:{snapshotLocation:"device",currentSnapshotId:"saved"},
 document:{querySelector:selector=>selector==="#newCanvasDialog"?dialog:input},canvasHasUnsavedChanges:()=>dirty,currentCanvasDisplayName:()=>"Task title",
 setNewCanvasDialogBusy:value=>calls.push(["busy",value]),updateNewCanvasDialog(){},canvasDocumentsCurrent:()=>({id:current}),canvasDocumentsCopy:en=>en,canvasDocumentsError:(_code,text)=>Error(text),
 saveSnapshot:async()=>{calls.push("save");if(saveError)throw Error("save failed");if(copy&&saveResult!==null)current="copy";return saveResult;},canvasDocumentsClose:async(id,sourceId)=>{calls.push(["close",id,sourceId]);return true;},
 t:key=>key,setStatus:text=>calls.push(text),loadSnapshot:()=>{throw Error("unexpected load");},startBlankCanvas:()=>{throw Error("unexpected new");},
 });
 vm.runInContext(["performCanvasTransition","requestCanvasTransition","completeNewCanvas","discardCanvasTransition"].map(extract).join("\n"),context);
 return {context,calls,dialog,input};
}
test("clean close executes directly; dirty close waits and retains its name",async()=>{
 const clean=setup({dirty:false});await clean.context.requestCanvasTransition({type:"close",documentId:"original"});assert.deepEqual(clean.calls,[["close","original",undefined]]);
 const dirty=setup();assert.equal(await dirty.context.requestCanvasTransition({type:"close",documentId:"original"}),false);assert.equal(dirty.dialog.open,true);assert.equal(dirty.input.value,"Task title");assert.equal(dirty.calls.some(x=>Array.isArray(x)&&x[0]==="close"),false);
 await dirty.context.discardCanvasTransition();assert.deepEqual(dirty.calls.at(-1),["close","original",undefined]);
});
test("save must succeed before close, including an independent Save as copy",async()=>{
 for(const options of [{saveResult:null},{saveError:true},{}, {copy:true}]){
  const h=setup(options);await h.context.requestCanvasTransition({type:"close",documentId:"original"});await h.context.completeNewCanvas("new");
  const close=h.calls.find(x=>Array.isArray(x)&&x[0]==="close");
  if(options.saveResult===null||options.saveError){assert.equal(close,undefined);assert.equal(h.dialog.open,true);assert.ok(h.context.pendingCanvasTransition);}
  else {assert.deepEqual(close,options.copy?["close","copy","original"]:["close","original",undefined]);assert.equal(h.dialog.open,false);}
 }
});
