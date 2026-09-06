'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function harness(){
 let next=0;const saved=[];
 const context=vm.createContext({state:{userRevision:1,textBoxes:[],images:[],aiFont:'sans-serif'},SIZE:32768,MAX_VISIBLE_TEXT_BOXES:100,MAX_VISIBLE_IMAGES:100,
 intersection:(a,b)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y,
 unionDirtyBounds:(a,b)=>!a?{...b}:{x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),w:Math.max(a.x+a.w,b.x+b.w)-Math.min(a.x,b.x),h:Math.max(a.y+a.h,b.y+b.h)-Math.min(a.y,b.y)},
 offscreen:(w,h)=>({width:w,height:h,getContext:()=>new Proxy({measureText:s=>({width:s.length*10})},{get:(o,k)=>o[k]||(()=>{})})}),
 renderedTextBoxRecord:async raw=>({id:`text-${++next}`,w:raw.maxWidth,h:40,...raw}),canvasBlob:async()=>({size:100}),
 imageRecord:raw=>({id:raw.id||`image-${++next}`,...raw}),canvasAgentBox:o=>({x:o.item.x,y:o.item.y,w:o.item.w,h:o.item.h}),
 canvasAgentObject:id=>{for(const [key,kind]of [['textBoxes','text'],['images','image']]){const item=context.state[key].find(i=>i.id===id);if(item)return{item,kind};}return null;},
 canvasAgentMutationIdle:()=>{},canvasAgentAssertRevision:r=>assert.equal(context.state.userRevision,r),canvasAgentAssertToolExecution:()=>{},
 plotView:()=>({xMin:-5,xMax:5,yMin:-10,yMax:10}),mcpPlanPlacement:()=>({placement:{x:1000,y:1000},layout:{}}),save:()=>saved.push(true),textBoxHistoryState:()=>[],imageHistoryState:()=>[],requestRender:()=>{},canvasAgentSyncState:()=>{},mcpQueueView:()=>{},mcpRuntime:{feedbackSequence:0},
 });
 const source=fs.readFileSync('src/client/app/ai-runtime.js','utf8'),start=source.indexOf('  function compileExpression('),end=source.indexOf('  async function plotObjectImage',start);
 vm.runInContext(source.slice(start,end)+fs.readFileSync('src/client/app/mcp-primitives.js','utf8')+';globalThis.api={mcpPrimitiveLayout,mcpPlotView,mcpPresentPrimitives};',context);
 return {context,...context.api,saved};
}
test('node layout and ID connectors require no client coordinates',()=>{
 const h=harness(),r=h.mcpPrimitiveLayout([{id:'a',type:'rect'},{id:'b',type:'ellipse'},{id:'edge',type:'arrow',from:'a',to:'b'}]);
 assert.ok(r.items[1].box.x>r.items[0].box.x+r.items[0].box.w);assert.equal(r.items[2].points.length,2);
 assert.throws(()=>h.mcpPrimitiveLayout([{id:'edge',type:'arrow',from:'missing',to:'other'}]),/endpoints/);
 assert.throws(()=>h.mcpPrimitiveLayout([{id:'a',type:'rect',width:4000}]),/too large/);
});
test('expression parsing is restricted and domains are sampled locally',()=>{
 const h=harness();assert.throws(()=>h.mcpPlotView({expression:'globalThis.alert(1)'}),/Unsupported|Unknown|Expression too complex/);
 assert.throws(()=>h.mcpPlotView({expression:'sqrt(-1)',xMin:0,xMax:2}),/no finite/);
 const view=h.mcpPlotView({expression:'sin(x)',xMin:-Math.PI,xMax:Math.PI});assert.ok(view.yMin<-1&&view.yMax>1);
 assert.equal(h.mcpPlotView({expression:'x^2',xMin:0,xMax:3,yMin:0,yMax:10}).yMax,10);
});
test('native batches replace owned stable objects and preserve user moves without creating Widgets',async()=>{
 const h=harness(),session={artifacts:new Map()},args={artifactId:'flow',title:'Flow',items:[{id:'a',type:'rect',text:'Plan'},{id:'b',type:'text',text:'Verify'}]};
 const first=await h.mcpPresentPrimitives(session,args,'drawing',{});assert.equal(first.objectIds.length,2);assert.equal(h.context.state.images.length,1);assert.equal(h.context.state.textBoxes.length,1);assert.equal(h.saved.length,2);
 const shape=h.context.state.images[0];shape.x+=50;const moved=shape.x;
 const second=await h.mcpPresentPrimitives(session,{...args,items:[{id:'a',type:'ellipse',text:'Done'}]},'drawing',{});
 assert.equal(second.objectIds[0],first.objectIds[0]);assert.equal(shape.x,moved);assert.equal(h.context.state.textBoxes.length,0);
 const stranger={id:'image-999',x:0,y:0,w:100,h:100};h.context.state.images.push(stranger);
 await h.mcpPresentPrimitives(session,args,'drawing',{});assert.ok(h.context.state.images.includes(stranger));
 assert.equal(first.feedbackCursor,0);
});
test('invalid batch and revoked asynchronous preparation leave Canvas untouched',async()=>{
 const h=harness(),session={artifacts:new Map()},args={artifactId:'bad',title:'Bad',items:[{id:'a',type:'text',text:'Ready'},{id:'b',type:'rect',text:'x'.repeat(1000)}]};
 await assert.rejects(h.mcpPresentPrimitives(session,args,'drawing',{}),/label is too long/);assert.equal(h.saved.length,0);assert.equal(h.context.state.textBoxes.length,0);assert.equal(session.artifacts.size,0);
 h.context.renderedTextBoxRecord=async raw=>{h.context.state.userRevision++;return {id:'t',w:100,h:40,...raw};};
 await assert.rejects(h.mcpPresentPrimitives(session,{...args,items:[args.items[0]]},'drawing',{}));assert.equal(h.saved.length,0);
});
test('updating one label reuses unchanged text and raster content',async()=>{
 const h=harness(),session={artifacts:new Map()},args={artifactId:'flow',title:'Flow',items:[{id:'a',type:'rect',text:'Plan'},{id:'b',type:'ellipse',text:'Build'},{id:'c',type:'text',text:'Review'}]};
 await h.mcpPresentPrimitives(session,args,'drawing',{});
 let encodes=0;h.context.canvasBlob=async()=>{encodes++;return{size:100};};h.context.renderedTextBoxRecord=async()=>{throw Error('unchanged text must not rerender');};
 await h.mcpPresentPrimitives(session,{...args,items:args.items.map(item=>item.id==='a'?{...item,text:'Done'}:item)},'drawing',{});
 assert.equal(encodes,1,'only the changed shape encodes a raster');
});
