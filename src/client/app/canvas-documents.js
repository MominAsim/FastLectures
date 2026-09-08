  // One visible Canvas; inactive documents contain data, never hidden iframe trees.
  // Ordinary saves carry this extension in bundle V2. This is not version history.
  var canvasDocuments = { records:new Map(), activeId:null, ready:null, db:null, switching:false, epoch:0, error:null, retry:null, receipts:new Map(), write:Promise.resolve() };
  const CANVAS_DOCUMENT_EXTENSION = "penechoDocument", CANVAS_WORKSPACE_EXTENSION = "penechoWorkspace";
  function canvasDocumentsCopy(en,zh) { return state.language === "zh" ? zh : en; }
  function canvasDocumentsError(code,message,details=null) { return Object.assign(Error(message),{code,details}); }
  async function canvasDocumentsBound(promise,ms=15000) {
    let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(canvasDocumentsError("STORAGE_TIMEOUT","This save location did not respond. Your Canvas is unchanged; reconnect and retry.",{retryable:true})),ms);})]);}finally{clearTimeout(timer);}
  }
  function canvasDocumentsId() { return canvasClientId(); }
  function canvasDocumentsObjectId(doc,kind) {
    const prefix=kind==="text"?"text-box":kind,indexKey=kind==="text"?"nextTextBoxId":kind==="image"?"nextImageId":"nextWidgetId";
    if(canvasDocumentsIsActive(doc))return `${prefix}-${state[indexKey]++}`;
    doc.nextIds||={};
    if(!doc.nextIds[kind])doc.nextIds[kind]=canvasDocumentsObjects(doc).filter(o=>o.kind===kind).reduce((maximum,o)=>Math.max(maximum,Number(o.item.id.split("-").at(-1))||0),0)+1;
    return `${prefix}-${doc.nextIds[kind]++}`;
  }
  function canvasDocumentsWidgetRecord(value) {
    const input={...value};if(!input.copyText)delete input.copyText;if(!input.copyLabel)delete input.copyLabel;
    const record=widgetRecord(input);
    // Stored records pass through widgetRecord again when shown. Its runtime
    // defaults use empty copy fields, but serialized optional fields must omit them.
    if(record&&!record.copyText)delete record.copyText;if(record&&!record.copyLabel)delete record.copyLabel;
    return record;
  }
  function canvasDocumentsMetadata(doc) {
    return {version:1,documentId:doc.id,title:doc.title,context:doc.context||"",bindings:doc.bindings||[],locators:doc.locators||[],processor:doc.processor||{kind:"penecho"}};
  }
  function canvasDocumentsCurrent() {
    if (canvasDocuments.activeId && canvasDocuments.records.has(canvasDocuments.activeId)) return canvasDocuments.records.get(canvasDocuments.activeId);
    const meta=canvasDocumentIdentity.normalizeMetadata(state.currentSnapshotBundleExtensions?.[CANVAS_DOCUMENT_EXTENSION]), id=meta?.documentId||canvasDocumentsId();
    const doc=canvasDocumentsRecord(meta||{version:1,documentId:id,title:state.currentSnapshotName||canvasDocumentsCopy("Untitled Canvas","未命名画布")});
    canvasDocuments.records.set(id,doc);canvasDocuments.activeId=id;
    return doc;
  }
  function canvasDocumentsRecord(meta,stored=null) {
    return {id:meta.documentId,title:meta.title||canvasDocumentsCopy("Untitled Canvas","未命名画布"),context:meta.context||"",bindings:meta.bindings||[],locators:meta.locators||[],processor:meta.processor||{kind:"penecho"},stored,
      revision:1,savedRevision:0,feedback:[],feedbackSequence:0,messages:[],messageSequence:0,changes:[],changeSequence:0,sessions:[],unseen:0,undo:[],redo:[],receipts:new Map()};
  }
  function canvasDocumentsUnseen(value) { return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
  function canvasDocumentsIsActive(doc) { return doc.id === canvasDocuments.activeId; }
  function canvasDocumentsExternal() {
    // Agent controls query this during boot, before the workspace is initialized.
    // Reading their state must not create a document or interrupt theme setup.
    return typeof canvasDocuments!=="undefined" && canvasDocuments.records.get(canvasDocuments.activeId)?.processor.kind === "external";
  }
  function canvasDocumentsSyncExtension(doc=canvasDocumentsCurrent()) {
    if (!canvasDocumentsIsActive(doc)) return;
    doc.title=(typeof currentCanvasDisplayName==="function"?currentCanvasDisplayName():state.currentSnapshotName)||doc.title;
    state.currentSnapshotBundleExtensions={...state.currentSnapshotBundleExtensions,[CANVAS_DOCUMENT_EXTENSION]:canvasDocumentsMetadata(doc),[CANVAS_WORKSPACE_EXTENSION]:canvasDocumentsWorkspaceData(doc)};
  }
  function canvasDocumentsWorkspaceData(doc) {
    const runtime=typeof mcpRuntime!=="undefined"?[...mcpRuntime.sessions.values()].filter(s=>s.documentId===doc.id):[];
    const binding=s=>JSON.stringify([s.sessionKey,s.client||""]);
    // Unresumed bindings remain durable. Runtime entries, including explicit
    // closure, replace the saved version of their own conversation only.
    const overridden=new Set(runtime.filter(s=>s.sessionKey).map(binding));
    const retained=(doc.sessions||[]).filter(s=>s.sessionKey&&!overridden.has(binding(s)));
    const current=[...new Map(runtime.map(s=>[s.sessionKey?binding(s):s.sessionId,s])).values()];
    const live=current.filter(s=>!s.closed).map(s=>({sessionKey:s.sessionKey||"",client:s.client||"",title:s.title,status:s.status,summary:s.summary,steps:s.steps,events:s.events,boardObjectId:s.boardObjectId,layout:s.layout,artifacts:[...s.artifacts],feedbackStart:s.feedbackStart}));
    // Keyless sessions remain transient and never acquire a reconnect binding.
    const sessions=[...retained,...live].slice(-64);
    return {version:1,sessions,feedback:doc.feedback.slice(-200),feedbackSequence:doc.feedbackSequence,messages:doc.messages.slice(-100),messageSequence:doc.messageSequence,changes:doc.changes.slice(-200),changeSequence:doc.changeSequence};
  }
  function canvasDocumentsRestoreWorkspace(doc,value) {
    const normalized=canvasDocumentIdentity.normalizeWorkspace(value,canvasDocumentsMetadata(doc));if(!normalized)return;
    for(const field of ["feedback","messages","changes","sessions","feedbackSequence","messageSequence","changeSequence"])doc[field]=normalized[field];
  }
  async function canvasDocumentsDb() {
    if(canvasDocuments.db)return canvasDocuments.db;
    const request=indexedDB.open("penecho-workspace-documents",1);
    request.onupgradeneeded=()=>request.result.createObjectStore("documents",{keyPath:"id"});
    canvasDocuments.db=await canvasDocumentsBound(requestResult(request));return canvasDocuments.db;
  }
  async function canvasDocumentsReady() {
    canvasDocumentsCurrent();
    if(!canvasDocuments.ready)canvasDocuments.ready=(async()=>{
      const db=await canvasDocumentsDb(),items=await canvasDocumentsBound(requestResult(db.transaction("documents","readonly").objectStore("documents").getAll()));
      for(const item of items.slice(-31)) {
        const meta=canvasDocumentIdentity.normalizeMetadata(item.metadata);
        if(!meta||canvasDocuments.records.has(meta.documentId))continue;
        const doc=canvasDocumentsRecord(meta,item.stored);canvasDocumentsRestoreWorkspace(doc,item.workspace);
        doc.revision=item.revision||1;doc.savedRevision=item.savedRevision||0;doc.unseen=canvasDocumentsUnseen(item.unseen);doc.locator=item.locator||null;doc.agentDraft=typeof item.agentDraft==="string"?item.agentDraft.slice(0,16000):"";
        canvasDocuments.records.set(doc.id,doc);
      }
      canvasDocumentsRender();
    })().catch(error=>{canvasDocuments.ready=null;throw error;});
    return canvasDocuments.ready;
  }
  async function canvasDocumentsPersist(doc) {
    const db=await canvasDocumentsDb(),payload={id:doc.id,metadata:canvasDocumentsMetadata(doc),stored:doc.stored,workspace:canvasDocumentsWorkspaceData(doc),revision:doc.revision,savedRevision:doc.savedRevision,unseen:canvasDocumentsUnseen(doc.unseen),locator:doc.locator||null,agentDraft:String(doc.agentDraft||"").slice(0,16000)};
    await canvasDocumentsBound(new Promise((resolve,reject)=>{const tx=db.transaction("documents","readwrite");tx.objectStore("documents").put(payload);tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(tx.error||Error("Could not save the workspace. Free device storage, then retry."));}));
  }
  function canvasDocumentsReport(error,retry=null) {
    canvasDocuments.error=String(error?.message||error);canvasDocuments.retry=retry;canvasDocumentsRender();
  }
  function canvasDocumentsChanged(doc,kind,objectId=null) {
    if(canvasDocumentsIsActive(doc))doc.revision=state.userRevision;else doc.revision++;
    doc.changes.push({cursor:++doc.changeSequence,kind,objectId,at:Date.now()});
    if(doc.changes.length>200)doc.changes.splice(0,doc.changes.length-200);
    if(!canvasDocumentsIsActive(doc))doc.unseen++;
    canvasDocumentsSyncExtension(doc);canvasDocumentsRender();
  }
  function canvasDocumentsActiveSnapshot() {
    return {version:2,id:state.currentSnapshotId,name:state.currentSnapshotName,theme:state.theme,view:canvasDocumentsSavedView(),widgets:serializedWidgets(),textBoxes:storedTextBoxes(),images:storedImages(),animations:serializedAnimations(),
      projectId:state.currentSnapshotProjectId,currentRevisionId:state.currentSnapshotRevisionId,bundleExtensions:snapshotExtensionObject(state.currentSnapshotBundleExtensions),manifestExtensions:snapshotExtensionObject(state.currentSnapshotManifestExtensions),preservedAssets:snapshotPreservedAssets(state.currentSnapshotPreservedAssets)};
  }
  function canvasDocumentsSavedView() {
    const view=viewportRect();return {scale:state.scale,panX:state.panX,panY:state.panY,navigationLocked:state.navigationLocked,region:{x:view.x,y:view.y,w:view.w,h:view.h}};
  }
  async function canvasDocumentsPark() {
    const doc=canvasDocumentsCurrent();
    await finalizeCanvasForSnapshot();
    const revision=state.userRevision,epoch=canvasDocuments.epoch;
    canvasDocumentsSyncExtension(doc);
    const item=canvasDocumentsActiveSnapshot(),tileEntries=await Promise.all([...tiles].map(async([k,c])=>({k,blob:await canvasBlob(c)})));
    if(epoch!==canvasDocuments.epoch||revision!==state.userRevision)throw canvasDocumentsError("CANVAS_CHANGED",canvasDocumentsCopy("The Canvas changed while preparing the switch. Your edits are kept; retry when ready.","切换准备期间画布发生了变化。修改已保留，请重试。"));
    doc.stored={item,tileEntries};doc.revision=revision;doc.savedRevision=state.snapshotSavedRevision;doc.undo=state.history;doc.redo=state.future;doc.agentDraft=typeof canvasAgentInput!=="undefined"?canvasAgentInput.value:"";
    doc.feedback=mcpRuntime.feedback;doc.feedbackSequence=mcpRuntime.feedbackSequence;
    await canvasDocumentsPersist(doc);return doc;
  }
  async function canvasDocumentsShow(id,execution=null) {
    const doc=canvasDocuments.records.get(id);
    if(!doc)throw canvasDocumentsError("DOCUMENT_NOT_FOUND","This Canvas is not open. Resolve its saved location and retry.");
    if(canvasDocumentsIsActive(doc)) { if(doc.unseen){doc.unseen=0;canvasDocumentsRender();await canvasDocumentsPersist(doc);} return {documentId:id,active:true}; }
    if(canvasDocuments.switching||snapshotLoadInProgress||typeof snapshotSaveInProgress!=="undefined"&&snapshotSaveInProgress)throw canvasDocumentsError("CANVAS_BUSY",canvasDocumentsCopy("A Canvas is opening or saving. Retry after it finishes.","画布正在打开或保存，完成后请重试。"));
    if(state.drawing||state.widgetGesture||state.imageGesture||state.selectionGesture)throw canvasDocumentsError("CANVAS_BUSY",canvasDocumentsCopy("Finish the current gesture, then retry switching Canvas.","请完成当前操作，再重试切换画布。"));
    if(typeof canvasAgent!=="undefined"&&(canvasAgent.running||canvasAgent.requestPending))throw canvasDocumentsError("CANVAS_BUSY",canvasDocumentsCopy("PenEcho Agent is working on this Canvas. Wait or use Stop, then retry switching.","PenEcho Agent 正在处理当前画布。请等待完成或点击停止，再重试切换。"));
    if(typeof canvasAgent!=="undefined"&&(canvasAgent.attachments?.length||canvasAgent.inkPresent))throw canvasDocumentsError("CANVAS_BUSY",canvasDocumentsCopy("Send or remove the Agent's attachments or handwriting before switching, then retry. Your draft is kept.","请先发送或移除 Agent 中的附件、手写输入，再重试切换。草稿已保留。"));
    canvasDocuments.switching=true;canvasDocumentsRender();
    let decoded=null;
    try {
      await canvasDocumentsPark();
      const revision=state.userRevision,targetRevision=doc.revision,epoch=canvasDocuments.epoch,stored=doc.stored||{item:{widgets:[],images:[],textBoxes:[],animations:[],theme:state.theme},tileEntries:[]};
      const current=()=>epoch===canvasDocuments.epoch&&revision===state.userRevision&&targetRevision===doc.revision&&!execution?.controller?.signal.aborted;
      await enableSnapshotWidgetPlugins(stored.item.widgets||[]);
      const results=await Promise.allSettled([decodeSnapshotTilesInBatches(stored.tileEntries||[],current),decodeSnapshotImagesInBatches(stored.item.images||[],current)]);
      if(results[0].status==="fulfilled")decoded=results[0].value;
      for(const result of results)if(result.status==="rejected")throw result.reason;
      // History uses decoded images. Hydrate only unique missing assets before swapping.
      const historyImages=new Map();
      for(const entry of [...doc.undo,...doc.redo])for(const key of ["imagesBefore","imagesAfter"])for(const image of entry[key]||[])if(!image.image&&image.blob){if(!historyImages.has(image.blob))historyImages.set(image.blob,decodeStoredImage(image));}
      for(const [blob,pending] of historyImages)historyImages.set(blob,await pending);
      for(const entry of [...doc.undo,...doc.redo])for(const key of ["imagesBefore","imagesAfter"])if(entry[key])entry[key]=entry[key].map(image=>image.image?image:historyImages.get(image.blob)||image);
      if(!current())throw canvasDocumentsError("CANVAS_CHANGED","The Canvas changed before switching. Your edits are kept; retry.");
      const images=results[1].value,item=stored.item;
      if(state.selection)cancelSelection(true);clearTextEditors();invalidateRecognition();cancelPendingForRevision();
      for(const c of tiles.values())c.width=c.height=1;
      tiles.clear();clearSharpOverlays();state.inkBounds.clear();
      for(const [k,c] of decoded)tiles.set(k,c);decoded.clear();
      mcpPauseView();canvasDocuments.activeId=id;canvasDocuments.epoch++;
      state.userRevision=doc.revision;state.history=doc.undo||[];state.future=doc.redo||[];state.historyBefore.clear();
      state.animationHistoryBefore=state.widgetHistoryBefore=state.imageHistoryBefore=state.textBoxHistoryBefore=null;
      restoreAnimations(item.animations||[]);restoreWidgets((item.widgets||[]).map(canvasDocumentsWidgetRecord).filter(Boolean));restoreImages(images||[]);await restoreTextBoxes(item.textBoxes||[],1);
      if(item.theme)applyTheme(item.theme);
      state.currentSnapshotId=doc.locator?.id||null;state.currentSnapshotLocation=doc.locator?.location||null;state.currentSnapshotName=doc.title;state.currentSnapshotHasExplicitName=Boolean(doc.locator||doc.title&&!/^(untitled canvas|未命名画布)$/i.test(doc.title.trim()));state.currentCanvasSuggestedName="";
      state.currentSnapshotProjectId=item.projectId||null;state.currentSnapshotRevisionId=item.currentRevisionId||null;state.snapshotSavedRevision=doc.savedRevision;
      state.currentSnapshotBundleExtensions=snapshotExtensionObject(item.bundleExtensions);state.currentSnapshotManifestExtensions=snapshotExtensionObject(item.manifestExtensions);state.currentSnapshotPreservedAssets=snapshotPreservedAssets(item.preservedAssets);
      mcpRuntime.feedback=doc.feedback;mcpRuntime.feedbackSequence=doc.feedbackSequence;
      canvasDocumentsSyncExtension(doc);canvasDocumentsApplyView(item.view);
      canvasAgentCanvasDidChange(doc.locator||{id:doc.id,location:"workspace"},{clearProject:true});
      if(typeof canvasAgentInput!=="undefined"){canvasAgentInput.value=doc.agentDraft||"";canvasAgentResizeInput();}
      doc.unseen=0;canvasDocuments.error=null;canvasDocuments.retry=null;render();canvasAgentSyncAutomaticAIStatus();mcpRenderCanvasStatus();
      window.PenEchoStudioNavigator?.updateDocument?.();await canvasDocumentsPersist(doc);return {documentId:id,active:true};
    } finally {if(decoded?.size)releaseSnapshotTileCanvases(decoded);canvasDocuments.switching=false;canvasDocumentsRender();}
  }
  function canvasDocumentsApplyView(view) {
    if(view?.region&&[view.region.x,view.region.y,view.region.w,view.region.h].every(Number.isFinite)&&view.region.w>0&&view.region.h>0)canvasAgentFrameRegion(view.region,0);
    else if(view){state.scale=Math.max(.03,Math.min(2,Number(view.scale)||1));state.panX=Number(view.panX)||0;state.panY=Number(view.panY)||0;updateCoordinates();}
    setCanvasNavigationLocked(view?.navigationLocked===true);
  }
  async function canvasDocumentsAdopt(item,location) {
    const locator={location,id:item.id},meta=canvasDocumentIdentity.normalizeMetadata(item.bundleExtensions?.[CANVAS_DOCUMENT_EXTENSION])||{version:1,documentId:await canvasDocumentIdentity.legacyId(locator),title:item.name||""};
    const doc=canvasDocuments.records.get(meta.documentId)||canvasDocumentsRecord(meta);
    doc.title=item.name||doc.title;doc.locator=locator;doc.locators=[...doc.locators.filter(l=>canvasDocumentIdentity.locatorKey(l)!==canvasDocumentIdentity.locatorKey(locator)),locator].slice(-16);
    canvasDocumentsRestoreWorkspace(doc,item.bundleExtensions?.[CANVAS_WORKSPACE_EXTENSION]);
    canvasDocuments.records.set(doc.id,doc);canvasDocuments.activeId=doc.id;canvasDocuments.epoch++;
    mcpRuntime.feedback=doc.feedback;mcpRuntime.feedbackSequence=doc.feedbackSequence;doc.revision=state.userRevision;doc.savedRevision=state.snapshotSavedRevision;
    canvasDocumentsSyncExtension(doc);canvasDocumentsRender();
  }
  function canvasDocumentsSaveMetadata({copy=false}={}) {
    const doc=canvasDocumentsCurrent(),metadata=canvasDocumentsMetadata(doc);
    if(copy){metadata.documentId=canvasDocumentsId();metadata.bindings=[];metadata.locators=[];metadata.processor={kind:"penecho"};}
    return {...state.currentSnapshotBundleExtensions,[CANVAS_DOCUMENT_EXTENSION]:metadata,[CANVAS_WORKSPACE_EXTENSION]:copy?{version:1}:canvasDocumentsWorkspaceData(doc)};
  }
  async function canvasDocumentsDidSave(item,location,storedId,tileEntries=[]) {
    const previous=canvasDocumentsCurrent(),nextId=item.bundleExtensions?.[CANVAS_DOCUMENT_EXTENSION]?.documentId;
    if(nextId&&nextId!==previous.id){
      previous.stored={item:{...item,id:previous.locator?.id||null,name:previous.title,bundleExtensions:{...item.bundleExtensions,[CANVAS_DOCUMENT_EXTENSION]:canvasDocumentsMetadata(previous),[CANVAS_WORKSPACE_EXTENSION]:canvasDocumentsWorkspaceData(previous)}},tileEntries};
      previous.undo=state.history;previous.redo=state.future;
      // An independent copy starts with its own Undo stack and external bindings.
      state.history=[];state.future=[];
    }
    await canvasDocumentsAdopt({...item,id:storedId},location);
    const doc=canvasDocumentsCurrent();doc.savedRevision=state.snapshotSavedRevision;doc.stored={item:{...item,id:storedId},tileEntries};canvasDocumentsSyncExtension(doc);
  }
  function canvasDocumentsObjects(doc) {
    if(canvasDocumentsIsActive(doc))return [...state.widgets.map(item=>({kind:"widget",item})),...state.textBoxes.map(item=>({kind:"text",item})),...state.images.map(item=>({kind:"image",item}))];
    const item=doc.stored?.item||{};return [...(item.widgets||[]).map(item=>({kind:"widget",item})),...(item.textBoxes||[]).map(item=>({kind:"text",item})),...(item.images||[]).map(item=>({kind:"image",item}))];
  }
  function canvasDocumentsBounds(object) { const {x,y,w,h}=object.item;return {x,y,w,h}; }
  function canvasDocumentsObject(doc,id) {return canvasDocumentsObjects(doc).find(o=>o.item.id===id);}
  function canvasDocumentsFilePaths(doc) {
    const entries=[{path:"canvas.json",writable:false},{path:"context.md",writable:true},{path:"layout.json",writable:false},{path:"view.json",writable:false},{path:"objects/index.json",writable:false},{path:"runtime/viewport.json",writable:false},{path:"runtime/selection.json",writable:false},{path:"runtime/changes.json",writable:false},{path:"runtime/messages.json",writable:false},{path:"ink/index.json",writable:false}];
    for(const object of canvasDocumentsObjects(doc)) {
      const root=`objects/${encodeURIComponent(object.item.id)}`,common={objectId:object.item.id,kind:object.kind,bounds:canvasDocumentsBounds(object)};
      entries.push({...common,path:`${root}/geometry.json`,writable:true});
      const names=object.kind==="widget"?["widget.json",...(object.item.widgetType==="diagram_source"?["widget.source"]:["widget.html",...(object.item.copyText&&object.item.copyText!==object.item.html?["widget.source"]:[])])]:object.kind==="text"?["content.txt"]:["image.json"];
      for(const name of names)entries.push({...common,path:`${root}/${name}`,writable:object.kind!=="image"});
    }
    return entries;
  }
  function canvasDocumentsPath(value) {return canvasDocumentIdentity.parsePath(value).join("/");}
  function canvasDocumentsFile(doc,path) {
    path=canvasDocumentsPath(path);
    const active=canvasDocumentsIsActive(doc),json=value=>JSON.stringify(value,null,2)+"\n";
    if(path==="canvas.json")return json({...canvasDocumentsMetadata(doc),active,revision:active?state.userRevision:doc.revision,coordinates:{units:"canvas",width:SIZE,height:SIZE},capabilities:{virtualFiles:true,history:false,automaticWake:false,backgroundCapture:false}});
    if(path==="context.md")return doc.context||"";
    if(path==="layout.json")return json({groups:[...mcpRuntime.sessions.values()].filter(s=>s.documentId===doc.id).map(s=>({bindingKey:s.sessionKey,title:s.title,layout:s.layout,objectIds:[s.boardObjectId,...[...s.artifacts.values()].flatMap(a=>a.objectIds||[a.objectId])].filter(Boolean)})),policy:"Preserve user geometry. Place related support below; compare beside when readable. New work starts within the viewport with top breathing room. Inspect previews are temporary."});
    if(path==="view.json")return json(doc.stored?.item.view|| (active?canvasDocumentsSavedView():null));
    if(path==="runtime/viewport.json")return json(active?{active:true,documentId:doc.id,...canvasAgentViewFacts(),region:viewportRect(),zoom:state.scale}:{active:false,documentId:doc.id,region:null,savedView:doc.stored?.item.view||null});
    if(path==="runtime/selection.json")return json(active?{active:true,objectIds:canvasAgentSelectionIds(),region:state.selection?.box||null}:{active:false,objectIds:[],region:null});
    if(path==="runtime/changes.json")return json({latestCursor:doc.changeSequence,earliestCursor:doc.changes[0]?.cursor||0,entries:doc.changes});
    if(path==="runtime/messages.json")return json({latestCursor:doc.messageSequence,entries:doc.messages});
    if(path==="objects/index.json")return json(canvasDocumentsObjects(doc).map(o=>({id:o.item.id,kind:o.kind,title:o.item.title||"",bounds:canvasDocumentsBounds(o),path:`objects/${encodeURIComponent(o.item.id)}/`})));
    if(path==="ink/index.json")return json({format:"raster-tiles",editableAsText:false,operations:["erase_ink"],tiles:active?[...tiles.keys()]: (doc.stored?.tileEntries||[]).map(t=>t.k)});
    const parts=canvasDocumentIdentity.parsePath(path);if(parts.length!==3||parts[0]!=="objects")throw canvasDocumentsError("FILE_NOT_FOUND","List the Canvas files and retry with an exact returned path.");
    const object=canvasDocumentsObject(doc,decodeURIComponent(parts[1]));if(!object)throw canvasDocumentsError("OBJECT_NOT_FOUND","This object was removed. List the Canvas files again.");
    const item=object.item,name=parts[2];
    if(name==="geometry.json")return json(canvasDocumentsBounds(object));
    if(object.kind==="text"&&name==="content.txt")return String(item.text||"");
    if(object.kind==="image"&&name==="image.json")return json({id:item.id,source:`penecho-ref:objects/${encodeURIComponent(item.id)}/image`,naturalW:item.naturalW,naturalH:item.naturalH,sourceName:item.sourceName||""});
    if(object.kind==="widget") {
      if(name==="widget.html"&&item.widgetType!=="diagram_source")return String(item.html||"");
      if(name==="widget.source")return String(item.widgetType==="diagram_source"?item.source||"":item.copyText||"");
      if(name==="widget.json")return json({title:item.title||"",refreshSeconds:item.refreshSeconds||0,widgetType:item.widgetType,pluginId:item.pluginId,sourceFormat:item.sourceFormat||null,frameworkVersion:item.frameworkVersion||null,copyLabel:item.copyLabel||null});
    }
    throw canvasDocumentsError("FILE_NOT_FOUND","This resource does not exist for this object. List its files first.");
  }
  function canvasDocumentsSpatial(doc) {
    const revision=canvasDocumentsIsActive(doc)?state.userRevision:doc.revision;
    if(doc.spatial?.revision===revision)return doc.spatial;
    const index={revision,cells:new Map(),boxes:new Map()};
    for(const object of canvasDocumentsObjects(doc))canvasDocumentsIndexBox(index,object.item.id,canvasDocumentsBounds(object));
    const ink=canvasDocumentsIsActive(doc)?[...tiles.keys()]:(doc.stored?.tileEntries||[]).map(t=>t.k);
    for(const k of ink){const [x,y]=k.split(",").map(Number);canvasDocumentsIndexBox(index,`ink:${k}`,{x:x*TILE,y:y*TILE,w:TILE,h:TILE});}
    doc.spatial=index;return index;
  }
  function canvasDocumentsCells(box) {
    const cells=[];for(let y=Math.floor(box.y/1024);y<=Math.floor((box.y+box.h)/1024);y++)for(let x=Math.floor(box.x/1024);x<=Math.floor((box.x+box.w)/1024);x++)cells.push(`${x},${y}`);return cells;
  }
  function canvasDocumentsIndexBox(index,id,box) {
    const previous=index.boxes.get(id);if(previous)for(const k of canvasDocumentsCells(previous))index.cells.get(k)?.delete(id);
    index.boxes.delete(id);if(!box)return;index.boxes.set(id,box);
    for(const k of canvasDocumentsCells(box)){if(!index.cells.has(k))index.cells.set(k,new Set());index.cells.get(k).add(id);}
  }
  function canvasDocumentsCollisions(doc,box,exclude=new Set()) {
    const index=canvasDocumentsSpatial(doc),ids=new Set(),result=[];
    for(const k of canvasDocumentsCells(box))for(const id of index.cells.get(k)||[])ids.add(id);
    for(const id of ids)if(!exclude.has(id)&&intersection(box,index.boxes.get(id)))result.push({id,...index.boxes.get(id)});
    return result;
  }
  function canvasDocumentsPlace(doc,w,h,session=null,presentation=null) {
    const active=canvasDocumentsIsActive(doc),view=active?viewportRect():doc.stored?.item?.view?.region,
      stage=active?canvasAgentFramePlan({x:0,y:0,w,h},96).stage:null,
      readingView=view?{...view,readableWidth:stage?.w?stage.w/.8:view.w*(doc.stored?.item?.view?.scale||1)/.8}:null;
    return mcpArrange(w,h,session,presentation,readingView,a=>{
      let bounds=null;for(const id of a.objectIds||[a.objectId]){const object=canvasDocumentsObject(doc,id);if(object)bounds=unionDirtyBounds(bounds,canvasDocumentsBounds(object));}return bounds;
    },box=>canvasDocumentsCollisions(doc,box));
  }
  function canvasDocumentsValidateGeometry(doc,box,excludeId=null) {
    if(!box||![box.x,box.y,box.w,box.h].every(Number.isFinite)||box.x<0||box.y<0||box.w<1||box.h<1||box.x+box.w>SIZE||box.y+box.h>SIZE)throw canvasDocumentsError("INVALID_GEOMETRY","Geometry must stay within the Canvas bounds.");
    const previous=excludeId?canvasDocumentsObject(doc,excludeId):null,old=previous?canvasDocumentsBounds(previous):null;
    const hits=canvasDocumentsCollisions(doc,box,new Set(excludeId?[excludeId]:[])).filter(hit=>!old||!intersection(old,hit));
    if(hits.length)throw canvasDocumentsError("LAYOUT_CONFLICT","This placement overlaps existing content. Keep its position or choose a free region and retry.",{obstacles:hits.slice(0,20)});
  }
  function canvasDocumentsBeginEdit(doc) {
    if(canvasDocumentsIsActive(doc)){save();state.widgetHistoryBefore=serializedWidgets();state.imageHistoryBefore=imageHistoryState();state.textBoxHistoryBefore=textBoxHistoryState();}
    else {const item=doc.stored.item;doc.pendingUndo={tiles:[],widgetsBefore:item.widgets.map(w=>({...w})),imagesBefore:item.images.map(i=>({...i})),textBoxesBefore:item.textBoxes.map(t=>({...t}))};}
  }
  function canvasDocumentsCapacity(doc,kind,delta=1) {
    const limit=kind==="text"?50:100;
    if(canvasDocumentsObjects(doc).filter(o=>o.kind===kind).length+delta>limit)throw canvasDocumentsError("OBJECT_LIMIT",canvasDocumentsCopy("This Canvas has reached its object limit. Remove an unused object or create another Canvas, then retry.","此画布的对象数量已达上限。请移除不用的对象，或新建画布后重试。"),{kind,limit,retryable:true});
  }
  function canvasDocumentsEndEdit(doc,kind,id=null) {
    if(canvasDocumentsIsActive(doc)){state.userRevision++;save();requestRender();canvasAgentSyncState();}
    else if(doc.pendingUndo){const item=doc.stored.item;Object.assign(doc.pendingUndo,{widgetsAfter:item.widgets.map(w=>({...w})),imagesAfter:item.images.map(i=>({...i})),textBoxesAfter:item.textBoxes.map(t=>({...t}))});doc.undo.push(doc.pendingUndo);doc.undo=doc.undo.slice(-MAX_HISTORY);doc.redo=[];doc.pendingUndo=null;}
    canvasDocumentsChanged(doc,kind,id);
    if(doc.spatial){const object=id?canvasDocumentsObject(doc,id):null;if(id)canvasDocumentsIndexBox(doc.spatial,id,object?canvasDocumentsBounds(object):null);else doc.spatial=null;if(doc.spatial)doc.spatial.revision=doc.revision;}
  }
  async function canvasDocumentsApplyFile(doc,args,execution) {
    const path=canvasDocumentsPath(args.path),before=canvasDocumentsFile(doc,path),hash=await canvasAgentHash(before);
    if(hash!==args.expectedHash)throw canvasDocumentsError("SOURCE_CONFLICT","This file changed after reading. Read it again and retry the patch with the new hash.",{currentHash:hash});
    if(typeof args.content!=="string"||new TextEncoder().encode(args.content).length>800000)throw canvasDocumentsError("INVALID_CONTENT","The source file is too large.");
    if(path==="context.md") {
      if(args.content.length>16000)throw canvasDocumentsError("CONTEXT_TOO_LARGE","Keep the task context under 16,000 characters.");
      canvasAgentAssertToolExecution(execution);
      if(canvasDocumentsFile(doc,path)!==before)throw canvasDocumentsError("SOURCE_CONFLICT","Task context changed. Read it again and retry.");
      if(canvasDocumentsIsActive(doc))state.userRevision++;
      doc.context=args.content;canvasDocumentsChanged(doc,"context");return {applied:true,contentHash:await canvasAgentHash(args.content)};
    }
    const parts=canvasDocumentIdentity.parsePath(path),object=parts[0]==="objects"?canvasDocumentsObject(doc,decodeURIComponent(parts[1])):null;
    if(!object)throw canvasDocumentsError("READ_ONLY_FILE","This is a derived runtime file. Use a Canvas action instead.");
    if(canvasDocumentsIsActive(doc))canvasAgentMutationIdle(execution);
    const field=parts[2],item=object.item;let replacement={...item};
    if(field==="geometry.json") {
      let geometry;try{geometry=JSON.parse(args.content);}catch{throw canvasDocumentsError("INVALID_JSON","Geometry must be valid JSON.");}
      if(Object.keys(geometry).some(k=>!["x","y","w","h"].includes(k)))throw canvasDocumentsError("INVALID_GEOMETRY","Geometry contains unsupported fields.");
      canvasDocumentsValidateGeometry(doc,geometry,item.id);Object.assign(replacement,geometry);
      if(object.kind==="widget"&&(geometry.w<300||geometry.h<200)||object.kind==="image"&&(geometry.w<80||geometry.h<80))throw canvasDocumentsError("INVALID_GEOMETRY","This size is below the object's supported minimum.");
      if(object.kind==="widget"){replacement.contentW=item.contentW*geometry.w/item.w;replacement.contentH=item.contentH*geometry.h/item.h;}
    } else if(object.kind==="text"&&field==="content.txt") {
      const made=await renderedTextBoxRecord({...item,text:args.content});if(!made)throw canvasDocumentsError("INVALID_TEXT","Text could not be rendered. Shorten it and retry.");replacement=made;
      canvasDocumentsValidateGeometry(doc,canvasDocumentsBounds({item:replacement}),item.id);
    } else if(object.kind==="widget"&&["widget.html","widget.source","widget.json"].includes(field)) {
      if(field==="widget.html") {replacement.html=args.content;if(widgetUsesHtmlCopySource(item))replacement.copyText=args.content;}
      else if(field==="widget.source") {if(item.widgetType==="diagram_source")replacement.source=args.content;else replacement.copyText=args.content;}
      else {
        let value;try{value=JSON.parse(args.content);}catch{throw canvasDocumentsError("INVALID_JSON","widget.json must remain valid JSON.");}
        const immutable={widgetType:item.widgetType,pluginId:item.pluginId,sourceFormat:item.sourceFormat||null,frameworkVersion:item.frameworkVersion||null};
        if(Object.keys(value).some(k=>![...Object.keys(immutable),"title","refreshSeconds","copyLabel"].includes(k))||Object.entries(immutable).some(([k,v])=>value[k]!==v)||typeof value.title!=="string"||value.title.length>120||!Number.isFinite(value.refreshSeconds)||value.refreshSeconds<0||value.refreshSeconds>86400)throw canvasDocumentsError("INVALID_MANIFEST","Keep the Widget type and source format unchanged; edit only title, refreshSeconds and copyLabel.");
        Object.assign(replacement,{title:value.title,refreshSeconds:value.refreshSeconds,copyLabel:typeof value.copyLabel==="string"?value.copyLabel.slice(0,120):undefined});
      }
      const validated=canvasDocumentsWidgetRecord(replacement);if(!validated)throw canvasDocumentsError("INVALID_WIDGET","Patched Widget source was rejected. Check its format and retry.");
      replacement=validated;
      if(canvasDocumentsIsActive(doc)) {
        if(canvasDocumentsFile(doc,path)!==before)throw canvasDocumentsError("SOURCE_CONFLICT","Source changed before applying. Read it again and retry.");
        const edit=widgetEditContext(item,"agent"),sourceHash=await canvasAgentHash(canvasAgentWidgetSourceState(edit));
        if(canvasDocumentsFile(doc,path)!==before)throw canvasDocumentsError("SOURCE_CONFLICT","Source changed before applying. Read it again and retry.");
        const result=await canvasAgentReplaceWidget({objectId:item.id,expectedSourceHash:sourceHash,changeId:args.requestId,command:{...replacement,tool:replacement.widgetType}},execution);
        canvasDocumentsChanged(doc,"source",item.id);return {...result,applied:true,contentHash:await canvasAgentHash(canvasDocumentsFile(doc,path))};
      }
    } else throw canvasDocumentsError("READ_ONLY_FILE","This file is read-only. Use replace_image or a Canvas action.");
    canvasAgentAssertToolExecution(execution);
    if(canvasDocumentsFile(doc,path)!==before)throw canvasDocumentsError("SOURCE_CONFLICT","Content changed before applying. Read it again and retry.");
    canvasDocumentsBeginEdit(doc);Object.assign(item,replacement);
    if(!canvasDocumentsIsActive(doc)&&object.kind==="text")delete item.image;
    if(canvasDocumentsIsActive(doc)&&object.kind==="widget")positionWidget(item);
    canvasDocumentsEndEdit(doc,"edit",item.id);return {applied:true,objectId:item.id,revision:doc.revision,contentHash:await canvasAgentHash(canvasDocumentsFile(doc,path))};
  }
  async function canvasDocumentsReadFile(doc,args,whole=false) {
    const session=mcpRuntime.sessions.get(args.sessionId),content=canvasDocumentsPath(args.path)==="runtime/messages.json"&&session?JSON.stringify({latestCursor:doc.messageSequence,entries:doc.messages.filter(m=>m.bindingKey===session.sessionKey&&m.client===session.client)},null,2)+"\n":canvasDocumentsFile(doc,args.path),contentHash=await canvasAgentHash(content);
    if(whole)return {content,contentHash};
    const lines=content.split("\n"),start=Math.max(1,Math.min(lines.length,args.startLine||1)),requestedEnd=Math.min(lines.length,args.endLine||start+199);
    let end=start-1,selected="";
    for(let index=start-1;index<requestedEnd;index++){const next=(end>=start?"\n":"")+lines[index];if(selected.length+next.length>200000)break;selected+=next;end=index+1;}
    if(end<start)throw canvasDocumentsError("LINE_TOO_LARGE","This line exceeds the read limit. Read individual object files or use the paginated message/feedback tools.");
    return {documentId:doc.id,path:canvasDocumentsPath(args.path),revision:canvasDocumentsIsActive(doc)?state.userRevision:doc.revision,contentHash,content:selected,lineRange:{start,end,total:lines.length},nextLine:end<lines.length?end+1:null,truncated:end<lines.length,contentFormat:"raw; no line-number prefix",originalEndsWithNewline:content.endsWith("\n")};
  }
  async function canvasDocumentsFind(args={}) {
    await canvasDocumentsReady();
    const candidates=[],providers=[];
    await Promise.all(["device","server","cloud"].map(async location=>{
      try {
        let items;
        if(location==="device")items=await canvasDocumentsBound(allSnapshots());
        else {
          const response=await fetch(location==="server"?"/api/canvases?metadataOnly=1":"/api/cloud/library",{headers:authenticatedApiHeaders(),credentials:"same-origin",cache:"no-store",signal:AbortSignal.timeout(12000)});
          if(!response.ok)throw Object.assign(Error(`${location}: ${response.status}`),{status:response.status});
          const body=await response.json();items=Array.isArray(body.canvases)?body.canvases:[];
        }
        for(const item of items) {
          const locator={location,id:item.id},metadata=canvasDocumentIdentity.normalizeMetadata(item.bundleExtensions?.[CANVAS_DOCUMENT_EXTENSION]),documentId=metadata?.documentId||item.documentId||await canvasDocumentIdentity.legacyId(locator);
          if(!args.documentId||args.documentId===documentId)candidates.push({documentId,title:item.name||"",locator,updatedAt:item.updatedAt||item.createdAt||0,active:false});
        }
        providers.push({location,status:"ok"});
      } catch(error) {providers.push({location,status:[401,403].includes(error.status)?"unauthorized":error.name==="TimeoutError"||error instanceof TypeError?"offline":"unavailable",retryable:true,message:String(error.message).slice(0,200)});}
    }));
    const active=[...canvasDocuments.records.values()].filter(doc=>!args.documentId||doc.id===args.documentId).map(doc=>({documentId:doc.id,title:doc.title,active:canvasDocumentsIsActive(doc),open:true,dirty:(canvasDocumentsIsActive(doc)?state.userRevision:doc.revision)!==doc.savedRevision,...(doc.locator?{locator:doc.locator}:{})}));
    return {canvases:[...active,...candidates.filter(c=>!active.some(a=>a.documentId===c.documentId&&a.locator?.location===c.locator.location&&a.locator?.id===c.locator.id))],providers};
  }
  async function canvasDocumentsOpen(args,execution) {
    await canvasDocumentsReady();
    let doc;
    if(args.create) {
      const id=`doc-${await canvasAgentHash(args.requestId)}`;
      if(canvasDocuments.records.size>=32&&!canvasDocuments.records.has(id))throw canvasDocumentsError("DOCUMENT_LIMIT","32 Canvases are already open. Save and close an unused Canvas, then retry.");
      doc=canvasDocuments.records.get(id)||canvasDocumentsRecord({documentId:id,title:args.title||"Untitled Canvas"},{item:{version:2,name:args.title||"Untitled Canvas",theme:state.theme,widgets:[],textBoxes:[],images:[],animations:[],bundleExtensions:{},manifestExtensions:{},preservedAssets:[]},tileEntries:[]});
      canvasDocuments.records.set(id,doc);
    } else {
      const open=[...canvasDocuments.records.values()].filter(d=>(!args.documentId||d.id===args.documentId)&&(!args.locator||d.locator?.location===args.locator.location&&d.locator?.id===args.locator.id));
      if(open.length===1)doc=open[0];
      else {
        let locator=args.locator;
        if(!locator) {
          const found=await canvasDocumentsFind(args),resolved=canvasDocumentIdentity.resolveCandidates({documentId:args.documentId,candidates:found.canvases,active:found.canvases.filter(c=>c.open),providers:found.providers});
          if(resolved.status!=="found")throw canvasDocumentsError(resolved.status==="ambiguous"?"DOCUMENT_AMBIGUOUS":resolved.status==="not_found"?"DOCUMENT_NOT_FOUND":"STORAGE_UNAVAILABLE",resolved.status==="ambiguous"?"Several saved copies match. Choose an exact location and retry.":resolved.status==="not_found"?"No saved Canvas matches this ID. Check its ID or create a new Canvas explicitly.":"A save location is unavailable. Reconnect or sign in, then retry.",resolved);
          locator=resolved.candidate.locator;
        }
        const stored=await canvasDocumentsBound(readSnapshot(locator.location,locator.id));
        if(!stored)throw canvasDocumentsError("DOCUMENT_NOT_FOUND","The saved Canvas was not found at this location.");
        const meta=canvasDocumentIdentity.normalizeMetadata(stored.item.bundleExtensions?.[CANVAS_DOCUMENT_EXTENSION])||{version:1,documentId:await canvasDocumentIdentity.legacyId(locator),title:stored.item.name||""};
        if(args.documentId&&meta.documentId!==args.documentId)throw canvasDocumentsError("DOCUMENT_CONFLICT","The saved location contains a different Canvas. Check its ID and retry.");
        if(canvasDocuments.records.has(meta.documentId))throw canvasDocumentsError("DOCUMENT_AMBIGUOUS","This Canvas is already open from another location. Use the open document or save an independent copy first.");
        doc=canvasDocumentsRecord(meta,stored);doc.locator=locator;canvasDocumentsRestoreWorkspace(doc,stored.item.bundleExtensions?.[CANVAS_WORKSPACE_EXTENSION]);canvasDocuments.records.set(doc.id,doc);
      }
    }
    canvasAgentAssertToolExecution(execution);await canvasDocumentsPersist(doc);
    if(args.show)await canvasDocumentsShow(doc.id,execution);
    canvasDocumentsRender();return {documentId:doc.id,title:doc.title,active:canvasDocumentsIsActive(doc),locator:doc.locator||null,created:args.create===true};
  }
  async function canvasDocumentsOnce(store,key,args,work) {
    if(!key)return work();
    const signature=JSON.stringify(args),previous=store.get(key);
    if(previous){if(previous.signature!==signature)throw canvasDocumentsError("REQUEST_ID_CONFLICT","This request ID was used for different content. Use a new request ID.");return previous.result;}
    const result=await work();store.set(key,{signature,result});if(store.size>256)store.delete(store.keys().next().value);return result;
  }
  function canvasDocumentsApplySessionTitle(doc,value) {
    const title=String(value||"").replace(/\s+/g," ").trim().slice(0,48).trim();
    const active=canvasDocumentsIsActive(doc),unnamed=!doc.title||/^(untitled canvas|未命名画布)$/i.test(doc.title.trim());
    if(!title||!unnamed||doc.locator||doc.locators?.length||active&&(state.currentSnapshotId||state.currentSnapshotHasExplicitName||state.currentCanvasSuggestedName))return false;
    if(active&&!applyCurrentCanvasGeneratedName(title))return false;
    doc.title=title;
    if(doc.stored?.item)doc.stored.item.name=title;
    return true;
  }
  function canvasDocumentsSession(doc,args) {
    const existing=(doc.sessions||[]).find(s=>args.sessionKey&&s.sessionKey===args.sessionKey&&(s.client||"")===(args.client||""));
    const session={sessionId:args.sessionId,documentId:doc.id,slotIndex:args.slotIndex||0,title:args.title,client:args.client||"",sessionKey:args.sessionKey||"",status:"working",summary:"",steps:[],events:[],artifacts:new Map(),feedbackStart:doc.feedbackSequence,createdAt:Date.now(),...existing};
    session.sessionId=args.sessionId;session.artifacts=new Map(existing?.artifacts||[]);session.closed=false;
    if(args.sessionKey) {
      if(doc.bindings.some(b=>b.key===args.sessionKey&&b.client!==(args.client||"")))throw canvasDocumentsError("BINDING_CONFLICT","This conversation key belongs to a different client. Use that client or a new key.");
      if(doc.bindings.length>=64&&!doc.bindings.some(b=>b.key===args.sessionKey))throw canvasDocumentsError("BINDING_LIMIT","This Canvas has 64 conversation bindings. Use another Canvas.");
      const conflict=[...canvasDocuments.records.values()].find(d=>d.id!==doc.id&&d.bindings.some(b=>b.key===args.sessionKey&&b.client===(args.client||"")));
      if(conflict)throw canvasDocumentsError("BINDING_CONFLICT","This conversation is bound to another Canvas. Reopen its documentId or use a new conversation key.",{documentId:conflict.id});
      if(!doc.bindings.some(b=>b.key===args.sessionKey&&b.client===(args.client||"")))doc.bindings.push({key:args.sessionKey,client:args.client||"",documentId:doc.id});
    }
    return session;
  }
  async function canvasDocumentsBackground(doc,name,args,execution) {
    const session=mcpRuntime.sessions.get(args.sessionId),item=doc.stored.item;
    if(!session||session.closed)throw canvasDocumentsError("SESSION_EXPIRED","Reconnect this Canvas session and retry.");
    if(name==="mcp_read_feedback") {
      const after=Math.max(session.feedbackStart,args.after??session.feedbackStart);if(after>doc.feedbackSequence)throw canvasDocumentsError("INVALID_CURSOR","Read feedback with the last cursor from this Canvas.");
      const pending=doc.feedback.filter(e=>e.cursor>after),entries=pending.slice(0,args.limit||20);
      if(entries.length&&args.capture!==false)throw canvasDocumentsError("CANVAS_NOT_VISIBLE","Feedback is retained. Show this Canvas to capture it, or retry with capture:false and read its files.",{documentId:doc.id,retryable:true});
      return {sessionId:session.sessionId,after,nextCursor:entries.at(-1)?.cursor||after,latestCursor:doc.feedbackSequence,hasMore:pending.length>entries.length,truncated:after<(doc.feedback[0]?.cursor||doc.feedbackSequence+1)-1,entries};
    }
    if(name==="mcp_inspect_session")return {sessionId:session.sessionId,boardObjectId:session.boardObjectId,...mcpProgressData(session),revision:doc.revision,visible:false,artifacts:[...session.artifacts].map(([artifactId,a])=>({artifactId,...a,bounds:canvasDocumentsObject(doc,a.objectId)?canvasDocumentsBounds(canvasDocumentsObject(doc,a.objectId)):null}))};
    if(name.startsWith("mcp_capture_"))throw canvasDocumentsError("CANVAS_NOT_VISIBLE","The content is applied in its Canvas. Show that Canvas and retry capture; no need to recreate it.",{documentId:doc.id,retryable:true,applied:true});
    if(name==="mcp_update_session"||name==="mcp_close_session") {
      const board=canvasDocumentsObject(doc,session.boardObjectId);
      for(const key of ["title","status","summary","steps"])if(args[key]!==undefined)session[key]=args[key];
      if(args.events){const events=new Map(session.events.map(e=>[e.id,e]));args.events.forEach(e=>events.set(e.id,e));session.events=[...events.values()].slice(-40);}
      if(name==="mcp_close_session"){session.status="done";session.closed=true;}
      if(board){board.item.html=mcpBoardHtml(session);board.item.title=session.title;}
      session.updatedAt=Date.now();
      if(board)canvasDocumentsChanged(doc,"progress",session.boardObjectId);
      else{doc.unseen++;canvasDocumentsSyncExtension(doc);canvasDocumentsRender();}
      return name==="mcp_close_session"?{closed:true,retainedOnCanvas:true}:{sessionId:session.sessionId,revision:doc.revision,applied:true,visible:false};
    }
    if(name==="mcp_present_widget") {
      const previous=session.artifacts.get(args.artifactId),object=previous?canvasDocumentsObject(doc,previous.objectId):null;
      if(previous&&!object)throw canvasDocumentsError("OBJECT_REMOVED","The user removed this artifact. Use a new artifact ID.");
      if(object&&object.kind!=="widget")throw canvasDocumentsError("KIND_MISMATCH","Use a new artifact ID for this Widget.");
      let widget=object?.item;
      if(!widget)canvasDocumentsCapacity(doc,"widget");
      const presentation=mcpPresentation(args,previous),size=mcpPresentationSize(args);
      const plan=widget?null:canvasDocumentsPlace(doc,size.width,size.height,session,presentation);
      const record=canvasDocumentsWidgetRecord({id:widget?.id||canvasDocumentsObjectId(doc,"widget"),widgetType:"html_widget",pluginId:"general",sourceFormat:"penecho-mcp+html",title:args.title,html:args.html,x:widget?.x??plan.placement.x,y:widget?.y??plan.placement.y,w:widget?.w||size.width,h:widget?.h||size.height,contentW:widget?.contentW||size.width,contentH:widget?.contentH||size.height,refreshSeconds:0});
      if(!record)throw canvasDocumentsError("INVALID_WIDGET","Widget source is invalid. Correct it and retry.");
      canvasAgentAssertToolExecution(execution);canvasDocumentsBeginEdit(doc);
      if(widget)Object.assign(widget,record);else{widget=record;item.widgets.push(widget);session.layout=plan.layout;}
      session.artifacts.set(args.artifactId,{objectId:widget.id,title:args.title,presentation});canvasDocumentsEndEdit(doc,"widget",widget.id);
      return {artifactId:args.artifactId,objectId:widget.id,revision:doc.revision,feedbackCursor:doc.feedbackSequence,visible:false,presentation,viewport:{width:widget.contentW,height:widget.contentH}};
    }
    if(name==="mcp_draw"||name==="mcp_plot")return canvasDocumentsBackgroundPrimitives(doc,session,args,name==="mcp_plot"?"plot":"drawing",execution);
    throw canvasDocumentsError("UNSUPPORTED_OPERATION",`Unsupported Canvas operation: ${name}`);
  }
  async function canvasDocumentsBackgroundPrimitives(doc,session,args,kind,execution) {
    const previous=session.artifacts.get(args.artifactId),old=new Map(previous?.elements||[]),prepared=[];
    if(previous&&previous.kind!==kind)throw canvasDocumentsError("KIND_MISMATCH","Use a new artifact ID for a different type of content.");
    for(const entry of old.values())if(!canvasDocumentsObject(doc,entry.objectId))throw canvasDocumentsError("OBJECT_REMOVED","An artifact object was removed. Use a new artifact ID.");
    let scene;
    if(kind==="plot") {
      const view=mcpPlotView(args),made=await plotObjectImage({expression:args.expression,title:args.title,w:args.width||900,h:args.height||600,color:args.color||state.inkColor,_mcpView:view});
      prepared.push({id:"plot",kind:"image",blob:made.blob,naturalW:made.image.width,naturalH:made.image.height,box:{x:0,y:0,w:made.logicalWidth,h:made.logicalHeight},plotExpression:args.expression});scene={bounds:prepared[0].box};
    } else {
      const inputs=[];
      for(const input of args.items) {
        let value={...input};const former=old.get(input.id),object=former&&canvasDocumentsObject(doc,former.objectId);
        if(object&&(input.type==="text")!==(object.kind==="text"))throw canvasDocumentsError("KIND_MISMATCH","Keep each element's type or use a new element ID.");
        if(input.type==="text") {const record=await renderedTextBoxRecord({text:input.text,x:0,y:0,fontSize:input.fontSize||20,maxWidth:input.width||260,fontFamily:state.aiFont,color:input.color||state.inkColor});if(!record)throw canvasDocumentsError("INVALID_TEXT","The text could not be rendered.");value={...value,width:record.w,height:record.h,record};}
        if(object&&!["line","arrow","path"].includes(input.type)){value.x=object.item.x-previous.origin.x;value.y=object.item.y-previous.origin.y;if(input.type!=="text"){value.width=object.item.w;value.height=object.item.h;}}
        inputs.push(value);
      }
      scene=mcpPrimitiveLayout(inputs);
      for(const value of scene.items) {
        if(value.type==="text")prepared.push({id:value.id,kind:"text",record:value.record,box:value.box,source:JSON.stringify(args.items.find(i=>i.id===value.id))});
        else {const image=mcpPrimitiveRaster(value),blob=await canvasBlob(image);prepared.push({id:value.id,kind:"image",blob,naturalW:image.width,naturalH:image.height,box:value.box});image.width=image.height=1;}
      }
    }
    canvasAgentAssertToolExecution(execution);
    const plan=previous?null:canvasDocumentsPlace(doc,scene.bounds.w,scene.bounds.h,session,mcpPresentation(args,previous)),origin=previous?.origin||{x:plan.placement.x-scene.bounds.x,y:plan.placement.y-scene.bounds.y},records=[],elements=new Map(),exclude=new Set(previous?.objectIds||[]);
    for(const entry of prepared) {
      const former=old.get(entry.id),object=former&&canvasDocumentsObject(doc,former.objectId),id=object?.item.id||canvasDocumentsObjectId(doc,entry.kind),box={x:object?.item.x??origin.x+entry.box.x,y:object?.item.y??origin.y+entry.box.y,w:entry.box.w,h:entry.box.h};
      if(box.x<0||box.y<0||box.x+box.w>SIZE||box.y+box.h>SIZE)throw canvasDocumentsError("INVALID_GEOMETRY","Drawing would leave the Canvas. Use a smaller artifact.");
      const collisions=canvasDocumentsCollisions(doc,box,exclude).filter(hit=>!object||!intersection(canvasDocumentsBounds(object),hit));
      if(collisions.length)throw canvasDocumentsError("LAYOUT_CONFLICT","The updated drawing needs more space. Move it or use a new artifact, then retry.");
      const record=entry.kind==="text"?{...entry.record,id,...box}:{id,...box,blob:entry.blob,naturalW:entry.naturalW,naturalH:entry.naturalH,sourceName:"",...(entry.plotExpression?{plotExpression:entry.plotExpression}:{})};
      if(entry.kind==="text")delete record.image;
      records.push({kind:entry.kind,record});elements.set(entry.id,{objectId:id,kind:entry.kind,...(entry.source?{source:entry.source}:{})});
    }
    for(const kind of ["text","image"])canvasDocumentsCapacity(doc,kind,records.filter(r=>r.kind===kind).length-canvasDocumentsObjects(doc).filter(o=>o.kind===kind&&exclude.has(o.item.id)).length);
    canvasDocumentsBeginEdit(doc);const item=doc.stored.item;
    item.images=item.images.filter(i=>!exclude.has(i.id));item.textBoxes=item.textBoxes.filter(t=>!exclude.has(t.id));
    for(const entry of records)item[entry.kind==="text"?"textBoxes":"images"].push(entry.record);
    const objectIds=records.map(r=>r.record.id);session.artifacts.set(args.artifactId,{kind,title:args.title,objectId:objectIds[0],objectIds,origin,presentation:mcpPresentation(args,previous),elements:[...elements]});if(plan)session.layout=plan.layout;
    canvasDocumentsEndEdit(doc,kind);return {artifactId:args.artifactId,objectId:objectIds[0],objectIds,kind,revision:doc.revision,feedbackCursor:doc.feedbackSequence,visible:false};
  }
  async function canvasDocumentsEdit(doc,args,execution) {
    if(args.action==="show") {
      await canvasDocumentsShow(doc.id,execution);
      execution.activeDocumentId=doc.id;execution.documentEpoch=canvasDocuments.epoch;
      const box=args.region||(args.objectId?canvasDocumentsBounds(canvasDocumentsObject(doc,args.objectId)):null);
      if(box)canvasAgentFrameRegion(box,48);return {documentId:doc.id,active:true};
    }
    if(canvasDocumentsIsActive(doc))canvasAgentMutationIdle(execution);
    if(!["create_text","show"].includes(args.action)&&args.baseRevision!==(canvasDocumentsIsActive(doc)?state.userRevision:doc.revision))throw canvasDocumentsError("REVISION_CONFLICT","The Canvas changed. Read canvas.json and retry with its current revision.");
    if(args.action==="create_text") {
      canvasDocumentsCapacity(doc,"text");
      const record=await renderedTextBoxRecord({id:canvasDocumentsObjectId(doc,"text"),text:args.text,x:0,y:0,fontSize:20,maxWidth:args.width||400,fontFamily:state.aiFont,color:state.inkColor});
      if(!record)throw canvasDocumentsError("INVALID_TEXT","Text could not be rendered. Shorten it and retry.");
      const placement=args.region||canvasDocumentsPlace(doc,record.w,record.h,mcpRuntime.sessions.get(args.sessionId)).placement;
      record.x=placement.x;record.y=placement.y;canvasDocumentsValidateGeometry(doc,canvasDocumentsBounds({item:record}));
      canvasAgentAssertToolExecution(execution);canvasDocumentsBeginEdit(doc);
      if(canvasDocumentsIsActive(doc))state.textBoxes.push(record);else {const {image,...stored}=record;doc.stored.item.textBoxes.push(stored);}
      canvasDocumentsEndEdit(doc,"create_text",record.id);return {applied:true,objectId:record.id,revision:doc.revision};
    }
    if(args.action==="erase_ink") {
      if(canvasDocumentsIsActive(doc))return canvasAgentEdit({baseRevision:state.userRevision,operations:[{type:"erase_ink",region:{x:args.region.x,y:args.region.y,width:args.region.w,height:args.region.h}}],_changeId:args.requestId},execution);
      const changed=[],tileEntries=[];
      for(const entry of doc.stored.tileEntries) {
        const [tx,ty]=entry.k.split(",").map(Number),box={x:tx*TILE,y:ty*TILE,w:TILE,h:TILE};
        if(!intersection(box,args.region)){tileEntries.push(entry);continue;}
        const bitmap=await createImageBitmap(entry.blob),canvas=offscreen(TILE,TILE);canvas.getContext("2d").drawImage(bitmap,0,0);bitmap.close();
        const before=cloneCanvas(canvas);canvas.getContext("2d").clearRect(args.region.x-box.x,args.region.y-box.y,args.region.w,args.region.h);
        tileEntries.push({k:entry.k,blob:await canvasBlob(canvas)});changed.push({k:entry.k,before,after:canvas});
      }
      canvasAgentAssertToolExecution(execution);doc.stored.tileEntries=tileEntries;doc.undo.push({tiles:changed});doc.redo=[];canvasDocumentsChanged(doc,"erase_ink");doc.spatial=null;return {applied:true,revision:doc.revision};
    }
    const object=canvasDocumentsObject(doc,args.objectId);if(!object)throw canvasDocumentsError("OBJECT_NOT_FOUND","This object was removed. List the Canvas files and retry.");
    if(args.action==="move"||args.action==="resize") {
      const path=`objects/${encodeURIComponent(args.objectId)}/geometry.json`,box=canvasDocumentsBounds(object);
      if(args.action==="move"){box.x=args.region.x;box.y=args.region.y;}else{if(args.width!==undefined)box.w=args.width;if(args.height!==undefined)box.h=args.height;}
      return canvasDocumentsApplyFile(doc,{path,expectedHash:await canvasAgentHash(canvasDocumentsFile(doc,path)),content:JSON.stringify(box),requestId:args.requestId},execution);
    }
    let replacement=null;
    if(args.action==="replace_image") {
      if(object.kind!=="image")throw canvasDocumentsError("KIND_MISMATCH","replace_image requires an image object.");
      let blob;
      if(args.source.startsWith("penecho-ref:")){const match=/^penecho-ref:objects\/([^/]+)\/image$/.exec(args.source),source=match?canvasDocumentsObject(doc,decodeURIComponent(match[1])):null;if(source?.kind!=="image")throw canvasDocumentsError("RESOURCE_NOT_FOUND","Use an image reference from this Canvas.");blob=source.item.blob;}
      else blob=dataUrlBlob(args.source);
      if(!["image/png","image/webp","image/jpeg"].includes(blob.type)||blob.size>MAX_IMAGE_SOURCE_BYTES)throw canvasDocumentsError("INVALID_IMAGE","Use a supported bounded PNG, JPEG or WebP image.");
      const image=await createImageBitmap(blob);
      if(image.width>MAX_IMAGE_DIMENSION||image.height>MAX_IMAGE_DIMENSION||image.width*image.height>MAX_IMAGE_PIXELS){image.close();throw canvasDocumentsError("INVALID_IMAGE","Resize the image to the supported Canvas image dimensions and retry.");}
      replacement={blob,image,naturalW:image.width,naturalH:image.height};
    }
    canvasAgentAssertToolExecution(execution);
    if(args.baseRevision!==(canvasDocumentsIsActive(doc)?state.userRevision:doc.revision))throw canvasDocumentsError("REVISION_CONFLICT","The Canvas changed while preparing the edit. Read canvas.json and retry.");
    canvasDocumentsBeginEdit(doc);
    if(args.action==="delete") {
      const collection=object.kind==="widget"?"widgets":object.kind==="text"?"textBoxes":"images",container=canvasDocumentsIsActive(doc)?state:doc.stored.item;
      if(canvasDocumentsIsActive(doc)&&object.kind==="widget")unmountWidget(object.item);
      container[collection]=container[collection].filter(i=>i.id!==args.objectId);
    } else if(replacement){Object.assign(object.item,replacement);if(!canvasDocumentsIsActive(doc)){delete object.item.image;replacement.image.close();}}
    else throw canvasDocumentsError("UNSUPPORTED_OPERATION","This Canvas action is not supported.");
    canvasDocumentsEndEdit(doc,args.action,args.objectId);return {applied:true,objectId:args.objectId,revision:doc.revision};
  }
  async function canvasDocumentsExecute(name,args,execution) {
    if(name==="mcp_start_session"&&!args.client)args={...args,client:"External AI"};
    if(name==="mcp_find_canvases")return canvasDocumentsFind(args);
    if(name==="mcp_open_canvas")return canvasDocumentsOnce(canvasDocuments.receipts,args.requestId,args,()=>canvasDocumentsOpen(args,execution));
    let session=mcpRuntime.sessions.get(args.sessionId),doc;
    if(name==="mcp_start_session") {
      await canvasDocumentsReady();
      doc=args.documentId?canvasDocuments.records.get(args.documentId):args.sessionKey?[...canvasDocuments.records.values()].find(d=>d.bindings.some(b=>b.key===args.sessionKey&&b.client===(args.client||""))):null;
      if(!doc&&!args.documentId){
        const visible=canvasDocumentsCurrent();
        if(args.sessionKey&&(visible.bindings.length||visible.locator||canvasDocumentsObjects(visible).length||tiles.size)){
          const created=await canvasDocumentsOpen({create:true,requestId:`conversation:${args.client||""}:${args.sessionKey}`,title:args.title,show:false},execution);doc=canvasDocuments.records.get(created.documentId);
        }else doc=visible;
      }
      if(!doc)throw canvasDocumentsError("DOCUMENT_NOT_FOUND","Open the documentId first, then retry starting the session.");
      session=canvasDocumentsSession(doc,args);
      canvasDocumentsApplySessionTitle(doc,session.title);
      execution.documentId=doc.id;execution.activeDocumentId=canvasDocumentsIsActive(doc)?doc.id:null;execution.documentEpoch=canvasDocuments.epoch;
      session.boardObjectId=session.boardObjectId||null;
      mcpRuntime.sessions.set(session.sessionId,session);
      if(args.takeover&&session.sessionKey)canvasDocumentsSetProcessor(doc,{kind:"external",bindingKey:session.sessionKey,client:session.client});
      canvasDocumentsSyncExtension(doc);canvasDocumentsRender();
      if(!canvasDocumentsIsActive(doc))await canvasDocumentsPersist(doc);
      return {sessionId:session.sessionId,documentId:doc.id,boardObjectId:session.boardObjectId,revision:canvasDocumentsIsActive(doc)?state.userRevision:doc.revision,feedbackCursor:session.feedbackStart,active:canvasDocumentsIsActive(doc),reused:Boolean(session.artifacts.size),progress:{title:session.title,status:session.status,summary:session.summary,steps:session.steps,events:session.events}};
    }
    if(!session||session.closed||session.documentId&&!canvasDocuments.records.has(session.documentId))throw canvasDocumentsError("SESSION_EXPIRED","The session is no longer connected. Reopen its documentId and reconnect, then retry.");
    doc=canvasDocuments.records.get(session.documentId)||canvasDocumentsCurrent();
    execution.documentId=doc.id;execution.activeDocumentId=canvasDocumentsIsActive(doc)?doc.id:null;execution.documentEpoch=canvasDocuments.epoch;
    if(name==="mcp_prepare_patch") {
      const receipt=doc.receipts.get(args.requestId);
      if(receipt) {
        const previous=JSON.parse(receipt.signature);
        if(previous.sessionId!==args.sessionId||previous.path!==args.path||previous.expectedHash!==args.expectedHash)throw canvasDocumentsError("REQUEST_ID_CONFLICT","This patch request ID belongs to different content. Use a new ID.");
        return {alreadyApplied:true,result:receipt.result};
      }
      return canvasDocumentsReadFile(doc,args,true);
    }
    if(name==="mcp_present_widget"&&args.presentation?.intent==="inspect")return {...await mcpInspectHtml(args,execution),revision:canvasDocumentsIsActive(doc)?state.userRevision:doc.revision,documentId:doc.id};
    const work=async()=>{
      let result;
      if(name==="mcp_list_files") {
        const path=canvasDocumentsPath(args.path||""),files=canvasDocumentsFilePaths(doc).filter(file=>(!path||file.path===path||file.path.startsWith(path+"/"))&&(!args.region||!file.bounds||intersection(file.bounds,args.region))),offset=args.offset||0,limit=args.limit||60;
        return {documentId:doc.id,entries:files.slice(offset,offset+limit),total:files.length,nextOffset:offset+limit<files.length?offset+limit:null};
      }
      if(name==="mcp_read_file"||name==="mcp_prepare_patch")return canvasDocumentsReadFile(doc,args,name==="mcp_prepare_patch");
      if(name==="mcp_capture_canvas") {
        if(!canvasDocumentsIsActive(doc))throw canvasDocumentsError("CANVAS_NOT_VISIBLE","Show this Canvas before capturing it, then retry. Its content is retained.",{documentId:doc.id,retryable:true});
        let target=args.target||"viewport",region=args.region;
        if(target==="object"){const object=canvasDocumentsObject(doc,args.objectId);if(!object)throw canvasDocumentsError("OBJECT_NOT_FOUND","The object was removed. List Canvas files and retry.");region=canvasDocumentsBounds(object);target="region";}
        return canvasAgentCapture({target,quality:args.quality||"basic",coordinates:"metadata",...(region?{region:{x:region.x,y:region.y,width:region.w,height:region.h}}:{})},{signal:execution.controller.signal,assertCurrent:()=>canvasAgentAssertToolExecution(execution)});
      }
      if(name==="mcp_apply_patch")result=await canvasDocumentsApplyFile(doc,args,execution);
      else if(name==="mcp_edit_canvas")result=await canvasDocumentsEdit(doc,args,execution);
      else if(name==="mcp_read_messages") {
        const all=doc.messages.filter(m=>m.bindingKey===session.sessionKey&&m.client===session.client),pending=all.filter(m=>m.cursor>(args.after||0)),entries=pending.slice(0,args.limit||20);
        return {documentId:doc.id,entries,nextCursor:entries.at(-1)?.cursor||args.after||0,latestCursor:doc.messageSequence,hasMore:pending.length>entries.length,delivery:"pull; reading does not acknowledge a message"};
      } else if(name==="mcp_ack_messages") {
        const allowed=new Set(args.ids),entries=doc.messages.filter(m=>allowed.has(m.id)&&m.bindingKey===session.sessionKey&&m.client===session.client);
        if(entries.length!==allowed.size)throw canvasDocumentsError("MESSAGE_NOT_FOUND","One or more messages do not belong to this conversation.");
        if(entries.some(m=>m.status==="cancelled"))throw canvasDocumentsError("MESSAGE_CANCELLED","The user cancelled this instruction. Do not execute it.");
        for(const message of entries){message.status=args.status;message.detail=args.message||"";message.updatedAt=Date.now();}
        canvasDocumentsSyncExtension(doc);canvasDocumentsRender();result={acknowledged:entries.map(m=>m.id),status:args.status};
      } else result=canvasDocumentsIsActive(doc)?await mcpExecute(name,args,execution):await canvasDocumentsBackground(doc,name,args,execution);
      if(!["mcp_inspect_session","mcp_read_feedback"].includes(name)) {
        doc.revision=canvasDocumentsIsActive(doc)?state.userRevision:doc.revision;canvasDocumentsSyncExtension(doc);
      }
      return {...result,documentId:doc.id};
    };
    const result=await canvasDocumentsOnce(doc.receipts,args.requestId,args,work);
    if(!canvasDocumentsIsActive(doc)&&!["mcp_list_files","mcp_read_file","mcp_prepare_patch","mcp_read_messages","mcp_inspect_session","mcp_read_feedback"].includes(name))await canvasDocumentsPersist(doc);
    return result;
  }
  function canvasDocumentsSetProcessor(doc,processor) {
    doc.processor=processor;doc.processorEpoch=(doc.processorEpoch||0)+1;
    if(canvasDocumentsIsActive(doc)) {
      clearTimeout(state.timer);state.timer=0;stopActiveAutomaticAI("canvas-processor-changed");
      canvasDocumentsSyncExtension(doc);canvasAgentSyncAutomaticAIStatus();
      if(processor.kind==="penecho")schedule();
    }
    canvasDocumentsRender();
  }
  function canvasDocumentsWidgetAction(widget,message) {
    if(typeof message.text!=="string"||!message.text.trim()||message.text.length>4000)return;
    const doc=canvasDocumentsCurrent(),session=[...mcpRuntime.sessions.values()].find(s=>s.documentId===doc.id&&!s.closed&&s.sessionKey&&[...s.artifacts.values()].some(a=>a.objectId===widget.id));
    if(!session)return;
    const text=message.text.trim(),previous=doc.messages.at(-1);
    if(previous?.objectIds?.includes(widget.id)&&previous.text===text&&Date.now()-previous.createdAt<800)return;
    if(doc.messages.filter(m=>!["done","cancelled"].includes(m.status)).length>=100){canvasDocumentsReport(canvasDocumentsCopy("The external inbox is full. Resolve pending instructions and retry.","外部待办已满，请先处理待办后重试。"));return;}
    canvasDocumentsMakeInboxRoom(doc);
    const entry={id:canvasDocumentsId(),cursor:++doc.messageSequence,bindingKey:session.sessionKey,client:session.client,text,objectIds:[widget.id],region:canvasDocumentsBounds({item:widget}),status:"queued",source:"widget",action:String(message.action||"choice").slice(0,80),createdAt:Date.now()};doc.messages.push(entry);doc.selectedMessageId=entry.id;
    canvasDocumentsSyncExtension(doc);canvasDocumentsRender();
  }
  function canvasDocumentsMakeInboxRoom(doc) {
    while(doc.messages.length>=100){const index=doc.messages.findIndex(m=>["done","cancelled"].includes(m.status));if(index<0)break;doc.messages.splice(index,1);}
  }
  function canvasDocumentsSelectedMessage(doc) {return doc.messages.find(m=>m.id===doc.selectedMessageId)||doc.messages.at(-1);}
  async function canvasDocumentsQueueMessage(options={}) {
    const doc=canvasDocumentsCurrent(),processor=doc.processor;
    if(processor.kind!=="external")return false;
    const text=String(options.textOverride===undefined?canvasAgentInput.value:options.textOverride).trim();
    if(!text)return false;
    if(canvasAgent.attachments.length||canvasAgent.inkPresent) {
      canvasDocumentsReport(canvasDocumentsCopy("External instructions currently support text and Canvas references. Place attachments on the Canvas, or select PenEcho Agent to send them.","外部指令目前支持文字和画布引用。请把附件放到画布上，或选择 PenEcho Agent 发送。"));return false;
    }
    if(text.length>16000){canvasDocumentsReport(canvasDocumentsCopy("This instruction is too long. Shorten it and retry.","这条指令过长，请精简后重试。"));return false;}
    if(doc.messages.filter(m=>!["done","cancelled"].includes(m.status)).length>=100){canvasDocumentsReport(canvasDocumentsCopy("The external inbox is full. Finish or cancel pending messages before retrying.","外部待办已满。请先处理或取消待办，再重试。"));return false;}
    const message={id:canvasDocumentsId(),cursor:++doc.messageSequence,bindingKey:processor.bindingKey,client:processor.client||"",text,objectIds:canvasAgentSelectionIds(),region:viewportRect(),status:"queued",createdAt:Date.now()};
    canvasDocumentsMakeInboxRoom(doc);doc.messages.push(message);doc.selectedMessageId=message.id;canvasDocumentsSyncExtension(doc);
    if(options.clearInput!==false&&options.textOverride===undefined){canvasAgentInput.value="";canvasAgentResizeInput();}
    canvasDocuments.error=null;canvasDocuments.retry=null;canvasDocumentsRender();
    // Capture/persist on this explicit send boundary, never on individual keystrokes.
    try{await canvasDocumentsPark();}catch(error){message.status="error";message.detail=String(error.message);canvasDocumentsReport(error,()=>canvasDocumentsRetryMessage(doc,message));}
    return true;
  }
  async function canvasDocumentsRetryMessage(doc,message) {
    message.status="queued";message.detail="";message.cursor=++doc.messageSequence;
    canvasDocuments.error=null;canvasDocuments.retry=null;canvasDocumentsSyncExtension(doc);canvasDocumentsRender();
    try{if(canvasDocumentsIsActive(doc))await canvasDocumentsPark();else await canvasDocumentsPersist(doc);}catch(error){message.status="error";canvasDocumentsReport(error,()=>canvasDocumentsRetryMessage(doc,message));}
  }
  function canvasDocumentsRender() {
    const root=document.getElementById("canvasWorkspace"),doc=canvasDocuments.records.get(canvasDocuments.activeId);
    if(doc)doc.title=(typeof currentCanvasDisplayName==="function"?currentCanvasDisplayName():state.currentSnapshotName)||doc.title;
    window.PenEchoStudioNavigator?.workspaceChanged?.();
    if(!root||!doc)return;
    root.hidden=false;
    const create=document.getElementById("canvasWorkspaceNew"),close=document.getElementById("canvasWorkspaceClose");
    create.textContent=canvasDocumentsCopy("New","新建");create.title=canvasDocumentsCopy("New Canvas","新建画布");create.setAttribute("aria-label",create.title);create.disabled=canvasDocuments.switching;
    close.textContent=canvasDocumentsCopy("Close","关闭");close.title=canvasDocumentsCopy("Close Canvas","关闭画布");close.setAttribute("aria-label",close.title);close.disabled=canvasDocuments.switching;
    const status=document.getElementById("canvasWorkspaceStatus"),retry=document.getElementById("canvasWorkspaceRetry");
    status.textContent=canvasDocuments.error||(canvasDocuments.switching?canvasDocumentsCopy("Opening…","正在打开…"):"");
    retry.hidden=!canvasDocuments.retry;retry.textContent=canvasDocumentsCopy("Retry","重试");
    const processorRow=document.getElementById("canvasProcessorRow"),processor=document.getElementById("canvasProcessorSelect");
    processorRow.hidden=!doc.bindings.length&&doc.processor.kind!=="external";
    const choices=[{value:"penecho",text:"PenEcho Agent"},...doc.bindings.map((b,index)=>({value:String(index),text:`${b.client||"External AI"} · ${canvasDocumentsCopy("external conversation","外部对话")}`}))],processorSignature=JSON.stringify(choices);
    if(processor.dataset.signature!==processorSignature){processor.replaceChildren(...choices.map(c=>{const option=document.createElement("option");option.value=c.value;option.textContent=c.text;return option;}));processor.dataset.signature=processorSignature;}
    processor.value=doc.processor.kind==="external"?String(doc.bindings.findIndex(b=>b.key===doc.processor.bindingKey&&b.client===doc.processor.client)):"penecho";
    document.getElementById("canvasProcessorLabel").textContent=canvasDocumentsCopy("Send to","发送给");
    document.getElementById("canvasProcessorHelp").textContent=doc.processor.kind==="external"?canvasDocumentsCopy("Instructions wait here for the connected conversation to read. Canvas Auto AI is paused.","指令会保留在这里，等待对应外部对话读取。画布 Auto AI 已暂停。") :canvasDocumentsCopy("PenEcho uses your selected model.","PenEcho 使用你选择的模型。");
    const latest=canvasDocumentsSelectedMessage(doc),messageRow=document.getElementById("canvasExternalMessage"),messageText=document.getElementById("canvasExternalMessageText"),messageRetry=document.getElementById("canvasExternalMessageRetry"),messageCancel=document.getElementById("canvasExternalMessageCancel"),messageSelect=document.getElementById("canvasExternalMessageSelect");
    if(messageSelect){const items=doc.messages.map(m=>({id:m.id,text:m.text.slice(0,90)})),key=JSON.stringify(items);if(messageSelect.dataset.signature!==key){messageSelect.replaceChildren(...items.map(m=>{const option=document.createElement("option");option.value=m.id;option.textContent=m.text;return option;}));messageSelect.dataset.signature=key;}messageSelect.value=latest?.id||"";messageSelect.setAttribute("aria-label",canvasDocumentsCopy("External instructions","外部指令"));messageSelect.title=latest?.text||"";}
    messageRow.hidden=!latest;if(latest){const labels={queued:canvasDocumentsCopy("Waiting for the external conversation to read. Continue there when ready.","等待外部对话读取。可以前往对应对话继续任务。"),received:canvasDocumentsCopy("Received by the external conversation.","外部对话已接收。"),working:canvasDocumentsCopy("The external conversation is working.","外部对话正在处理。"),done:canvasDocumentsCopy("Completed by the external conversation.","外部对话已完成。"),error:canvasDocumentsCopy("Could not complete. Your instruction is kept; retry or switch to PenEcho.","未能完成。指令已保留，可以重试或切换到 PenEcho。"),cancelled:canvasDocumentsCopy("Cancelled.","已取消。")};messageText.textContent=`${labels[latest.status]||labels.queued} ${latest.detail||""}`;messageRetry.hidden=!["queued","error"].includes(latest.status);messageRetry.textContent=canvasDocumentsCopy("Retry","重试");messageCancel.hidden=["done","cancelled"].includes(latest.status);messageCancel.textContent=canvasDocumentsCopy("Cancel","取消");}
    if(typeof canvasAgentSyncSendAvailability==="function")canvasAgentSyncSendAvailability();
  }
  function canvasDocumentsUiAction(work) {
    canvasDocuments.error=null;canvasDocuments.retry=null;
    void work().catch(error=>canvasDocumentsReport(error,work));
  }
  document.getElementById("canvasWorkspaceNew")?.addEventListener("click",()=>{const id=canvasDocumentsId();canvasDocumentsUiAction(async()=>{
    if(!canvasDocuments.records.has(id)){if(canvasDocuments.records.size>=32)throw canvasDocumentsError("DOCUMENT_LIMIT",canvasDocumentsCopy("Save and close an unused Canvas, then retry.","请先保存并关闭不用的画布，再重试。"));const doc=canvasDocumentsRecord({documentId:id,title:canvasDocumentsCopy("Untitled Canvas","未命名画布")},{item:{widgets:[],textBoxes:[],images:[],animations:[],theme:state.theme},tileEntries:[]});canvasDocuments.records.set(id,doc);}await canvasDocumentsShow(id);
  });});
  async function canvasDocumentsClose(id,sourceDocumentId=null) {
    const doc=canvasDocuments.records.get(id);
    if(!doc)return false;
    if(!canvasDocumentsIsActive(doc))throw canvasDocumentsError("CANVAS_CHANGED",canvasDocumentsCopy("The active Canvas changed. Close it again when ready.","当前画布已切换，请重新选择要关闭的画布。"));
    const closingIds=new Set([id,...(sourceDocumentId?[sourceDocumentId]:[])]);
    let next=[...canvasDocuments.records.values()].find(d=>!closingIds.has(d.id)),created=false;
    if(!next){next=canvasDocumentsRecord({documentId:canvasDocumentsId(),title:canvasDocumentsCopy("Untitled Canvas","未命名画布")},{item:{widgets:[],textBoxes:[],images:[],animations:[],theme:state.theme},tileEntries:[]});canvasDocuments.records.set(next.id,next);created=true;}
    try{await canvasDocumentsShow(next.id);}catch(error){if(created&&!canvasDocumentsIsActive(next))canvasDocuments.records.delete(next.id);throw error;}
    const db=await canvasDocumentsDb();
    await canvasDocumentsBound(new Promise((resolve,reject)=>{const tx=db.transaction("documents","readwrite");for(const closingId of closingIds)tx.objectStore("documents").delete(closingId);tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(tx.error||Error("Could not close the Canvas. Retry."));}));
    for(const session of mcpRuntime.sessions.values())if(closingIds.has(session.documentId))session.closed=true;
    for(const closingId of closingIds)canvasDocuments.records.delete(closingId);canvasDocumentsRender();return true;
  }
  document.getElementById("canvasWorkspaceClose")?.addEventListener("click",()=>{const documentId=canvasDocumentsCurrent().id;canvasDocumentsUiAction(()=>requestCanvasTransition({type:"close",documentId}));});
  document.getElementById("canvasWorkspaceRetry")?.addEventListener("click",()=>{const retry=canvasDocuments.retry;if(retry)canvasDocumentsUiAction(retry);});
  document.getElementById("canvasProcessorSelect")?.addEventListener("change",event=>{const doc=canvasDocumentsCurrent(),binding=doc.bindings[Number(event.target.value)];canvasDocumentsSetProcessor(doc,event.target.value==="penecho"||!binding?{kind:"penecho"}:{kind:"external",bindingKey:binding.key,client:binding.client});});
  document.getElementById("canvasExternalMessageSelect")?.addEventListener("change",event=>{canvasDocumentsCurrent().selectedMessageId=event.target.value;canvasDocumentsRender();});
  document.getElementById("canvasExternalMessageRetry")?.addEventListener("click",()=>{const doc=canvasDocumentsCurrent(),message=canvasDocumentsSelectedMessage(doc);if(message)void canvasDocumentsRetryMessage(doc,message);});
  document.getElementById("canvasExternalMessageCancel")?.addEventListener("click",()=>{const doc=canvasDocumentsCurrent(),message=canvasDocumentsSelectedMessage(doc);if(message){message.status="cancelled";message.cursor=++doc.messageSequence;canvasDocumentsSyncExtension(doc);canvasDocumentsRender();canvasDocumentsUiAction(()=>canvasDocumentsPark());}});
