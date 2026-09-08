  // External MCP sessions share Canvas primitives, but never an Agent conversation.
  var mcpRuntime = { socket:null, generation:0, sessions:new Map(), previews:new Map(), controllers:new Map(), queue:Promise.resolve(), queued:0, status:null, loading:null, loadError:null, configuring:false, configureResult:null, feedbackSequence:0, feedback:[], ready:false, connectionLost:false, heartbeatTimer:0, heartbeatSupported:false, lastPong:0, activeMutation:null, mutationDocumentId:null, glowTimer:0, glowing:false, pendingView:new Map(), layoutTimer:0, layoutSince:0, viewPaused:false, exampleStatusTimer:0 };
  const mcpCopy = {
    checkingSetup:["Checking MCP setup…","正在检查 MCP 配置…"],
    toolbarSetup:["Set up MCP Server","配置 MCP Server"],
    toolbarOpen:["Make canvases discoverable to external AI","允许外部 AI 发现并编辑画布"],
    toolbarClose:["Turn off MCP discovery","关闭 MCP 开放"],
    toolbarRetry:["Connection failed. Click MCP Server to retry.","连接失败。点击 MCP Server 重试。"],
    nav:["MCP service","MCP 服务"], eyebrow:["MCP Service","MCP 服务"], heading:["Give your AI a spatial workspace", "给你的 AI 一个空间工作区"],
    canvasNotice:["MCP connected · AI can update this canvas","MCP 已连接 · AI 可更新此画布"],
    canvasWaiting:["MCP open · Waiting for AI","MCP 已开放 · 等待 AI"],
    canvasLost:["MCP connection lost","MCP 连接已断开"],
    canvasApplying:["is updating the canvas…","正在更新画布…"],
    canvasSessions:["sessions","个会话"],
    canvasSession:["session","个会话"],
    newContent:["Show new content","查看新内容"],
    lastUpdate:["Last update","最近更新"],
    canvasNoticeHelp:["Open MCP settings to manage or turn off access to this canvas.","打开 MCP 设置，管理或关闭对此画布的访问。"],
    description:["Connect Codex or Claude. Show, annotate and iterate on Canvas.", "连接 Codex、Claude，在画布上展示、批注、迭代。"],
    enable:["Make workspace discoverable", "开放空间工作区"],
    accessHelp:["Connected clients can find and open your Device, Server and connected Cloud canvases, read their content, and edit the Canvas bound to a conversation. Images are captured on request. Turn this off to disconnect all external sessions.","外部客户端可查找并打开本设备、Server 和已连接 Cloud 中的画布，读取内容，并编辑对话绑定的画布。截图按需获取。关闭后会断开全部外部会话。"],
    stepOpen:["Open your workspace","开放你的工作区"],
    stepOpenHint:["Connected AI can read and edit your canvases, and open Device, Server and Cloud documents.","连接的 AI 可以读取和编辑你的画布，也能打开本设备、Server 与 Cloud 中的文档。"],
    stepOpenNote:["Turning this off disconnects all external sessions.","关闭后会断开全部外部会话。"],
    setup:["Connect your AI client", "连接你的 AI 客户端"],refresh:["Check again", "重新检查"],
    setupHint:["PenEcho writes the MCP entry on this computer. Other browsers can open MCP here; client setup stays on the PenEcho host.","PenEcho 会在这台电脑上写入 MCP 配置。其他浏览器可在此开放 MCP；AI 客户端配置仍在 PenEcho 主机上完成。"],
    clientCodexHint:["Terminal AI client","终端 AI 客户端"],
    clientClaudeHint:["Terminal AI client","终端 AI 客户端"],
    clientOtherHint:["Kimi / ZCode / any MCP client","Kimi / ZCode 等 MCP 客户端"],
    configure:["Auto configure", "自动配置"],copyConfig:["Copy config", "复制配置"],copyInstructions:["Copy setup prompt", "复制配置指引"],
    session:["Start a session","开始一个会话"],
    sessionHint:["Reload your AI client, then paste one of these prompts.","重载 AI 客户端，然后粘贴其中一条提示词。"],
    copyPrompt:["Copy prompt","复制提示词"],exampleCopied:["Prompt copied","提示词已复制"],
    exampleDesignTitle:["Three design options","三个设计方案"],
    exampleDesignPrompt:["Echo this UI idea in PenEcho with three design options, then let me choose.", "帮我 echo 一下这个界面想法，在 PenEcho 上展示三个方案，让我选择。"],
    exampleArchTitle:["Compare architectures","新旧架构对比"],
    exampleArchPrompt:["Compare the old and new architecture as a diagram on canvas.", "把新旧架构的对比放到 canvas 上，用图形展示差异。"],
    exampleWidgetTitle:["Handwriting to Widget","手写内容转 Widget"],
    exampleWidgetPrompt:["Turn the handwriting on this canvas into an interactive Widget.", "把当前画布上的手写内容整理成一个可交互的 Widget。"],
    exampleFolderTitle:["Show a folder","展示文件夹内容"],
    exampleFolderPrompt:["PenEcho the current folder’s architecture as a diagram.", "帮我 penecho 一下当前文件夹的架构。"],
    exampleCodeTitle:["Echo code changes","改代码并回显重点"],
    exampleCodePrompt:["Put your proposed code changes on canvas for review, then echo the implemented changes.", "把你要做的代码修改放到 canvas 上供我确认，完成后 echo 一下重点改动。"],
    exampleFeedbackTitle:["Revise from feedback","根据界面反馈修改"],
    exampleFeedbackPrompt:["Read my latest feedback and annotations on the current PenEcho canvas, then revise the existing UI in place.","读取我在当前 PenEcho 画布上的最新反馈和批注，根据这些反馈修改现有界面。"],
    manualSteps:["On the computer running PenEcho, select Codex or Claude Code and choose Auto configure. For another client, copy the setup prompt or add the JSON below to its MCP settings, then reload the client.","在运行 PenEcho 的电脑上，选择 Codex 或 Claude Code 并点击自动配置。其他客户端可复制配置指引，或将下方 JSON 添加到其 MCP 设置，然后重载客户端。"],
    remoteManualSteps:["On the computer running PenEcho, open Settings → MCP service. Select Codex or Claude Code and choose Auto configure; for another client, expand Manual setup and copy its configuration into the client’s MCP settings. Reload the client, then return here and open your workspace.","在运行 PenEcho 的电脑上打开 Settings → MCP 服务。选择 Codex 或 Claude Code 并点击自动配置；其他客户端展开手动配置，将配置复制到客户端的 MCP 设置中。重载客户端后，回到此页面开放工作区。"],
    capDrawTitle:["Draw & annotate","绘图与批注"],capDrawHint:["Diagrams, notes and sketches","关系图、笔记与草图"],
    capPlotTitle:["Plots & Widgets","函数图与 Widget"],capPlotHint:["Curves and interactive UI","曲线与交互界面"],
    capCaptureTitle:["Capture on request","按需截图"],capCaptureHint:["Screenshots only when asked","仅在你要求时截图"],
    manual:["Manual setup & details", "手动配置与详情"],manualHint:["Config JSON · Skill · Guide","配置 JSON · 技能 · 指南"],
    copySkill:["Copy skill", "复制技能"],copyGuide:["Copy guide", "复制指南"],
    how:["How to use it","如何使用"],
    howHelp:["Ask your AI to show useful work and revise it from your feedback. Use lightweight drawings for text and diagrams, function plots for curves, and Widgets for interactive UI. Request a screenshot when checking a design. Progress updates do not call another model or take screenshots.","让 AI 展示有用的成果，并结合你的反馈继续修改。文字和关系图使用轻量绘图，曲线使用函数图，交互 UI 使用 Widget。检查设计时再获取截图。进度更新不调用额外模型，也不生成截图。"],
    thoughtHelp:["Shows the AI’s shared plans, decisions and results. Session updates are supplied by the external AI client.","展示 AI 分享的计划、决策和结果。会话更新由外部 AI 客户端主动提供。"],
    connected:["Discoverable · AI can connect", "已可被发现 · AI 可连接"], disconnected:["Not discoverable", "未开放"],connecting:["Opening MCP Server…", "正在开放 MCP Server…"],
    localOnly:["Open an editable Canvas to enable MCP. Read-only viewers cannot register.","请打开可编辑画布以启用 MCP。只读查看页不能注册。"],
    copied:["Copied","已复制"],configured:["Reload your AI client to finish.", "重载 AI 客户端即可完成。"],
    loadingConfig:["Loading connection configuration…","正在加载连接配置…"],
    configuring:["Configuring…","正在配置…"],
    configurePending:["Saving the MCP configuration. This may take up to 20 seconds.","正在保存 MCP 配置，可能需要约 20 秒。"],
    configureSaved:["Configuration saved","配置已保存"],
    configureExisting:["Existing configuration found · not verified","已发现已有配置 · 尚未验证"],
    configureExistingHelp:["No changes were made. Reload this AI client and check for PenEcho tools. If they are unavailable, compare its existing entry with Manual configuration below.","本次未修改配置。请重新加载此 AI 客户端，检查是否出现 PenEcho 工具；若未出现，请对照下方“手动配置”检查已有条目。"],
    configureFailed:["Automatic configuration failed","自动配置失败"],
    configureFailedHelp:["Retry, or open Manual setup & details and copy the setup prompt.","请重试，或展开“手动配置与详情”，复制配置指引。"],
    configureUncertain:["Configuration result not confirmed","配置结果尚未确认"],
    configureUncertainHelp:["The request did not finish. Check the AI client's PenEcho entry before retrying; it may already have been saved.","请求未完成。重试前请检查 AI 客户端中的 PenEcho 条目，配置可能已经保存。"],
    loadFailed:["Could not load configuration. Select Check again.","未能加载配置。请点击“重新检查”。"],
    serviceOutdated:["This running PenEcho service has no usable MCP configuration. Restart PenEcho to load the updated service, then check again.","当前运行的 PenEcho 服务未提供有效的 MCP 配置。请重启 PenEcho 以加载更新后的服务，然后重新检查。"],
    hostRequired:["Configure MCP on the computer running PenEcho. Other devices can view the canvas but cannot configure its local AI clients.","请在运行 PenEcho 的电脑上配置 MCP。其他设备可以查看画布，但不能配置这台电脑的 AI 客户端。"],
    remoteSetup:["Open this workspace here. Configure the AI client on the computer running PenEcho; it can discover this browser through its existing MCP connection.","在此开放工作区。在运行 PenEcho 的电脑上配置 AI 客户端，即可通过已有 MCP 连接发现此浏览器。"],
    deviceOffline:["The linked PenEcho host is unavailable. Reconnect it, then retry MCP.","已连接的 PenEcho 主机不可用。恢复设备连接后重试 MCP。"],
    deviceUpdate:["Update PenEcho on the linked computer to enable MCP, then retry.","请更新已连接电脑上的 PenEcho，再重试 MCP。"],
    accessDenied:["MCP access was refused. On the PenEcho computer, try its localhost address, or refresh and unlock this page before checking again.","MCP 访问被拒绝。请在 PenEcho 所在电脑尝试 localhost 地址，或刷新并解锁页面后重新检查。"],
    focus:["Show","定位"],working:["Working","进行中"],waiting:["Waiting","等待中"],done:["Done","已完成"],error:["Needs attention","需要处理"],
  };
  function mcpText(key) { return mcpCopy[key]?.[state.language === "zh" ? 1 : 0] || key; }
  function mcpEl(id) { return document.getElementById(id); }
  const mcpClientInputs = [...document.querySelectorAll('input[name="mcpClient"]')];
  function mcpSelectedClient() { return mcpClientInputs.find(input=>input.checked)?.value || "codex"; }
  function mcpLocal() { return window.PENECHO_CONFIG?.runtime !== "viewer"; }
  function mcpRemoteBrowser() { return window.PENECHO_CONFIG?.runtime === "cloud" || mcpRuntime.status?.canConfigureLocalClients === false; }
  function mcpExecutionCurrent(execution) {
    return execution.socket === mcpRuntime.socket && execution.socket?.readyState === WebSocket.OPEN
      && execution.generation === mcpRuntime.generation && !execution.controller.signal.aborted
      && (typeof canvasDocuments==="undefined" || !execution.documentId || execution.documentEpoch===canvasDocuments.epoch)
      && (!execution.activeDocumentId || typeof canvasDocuments==="undefined" || execution.activeDocumentId===canvasDocuments.activeId);
  }
  function mcpDisconnect(lost=false) {
    if(!mcpRuntime)return;
    if(typeof canvasDocuments!=="undefined"&&canvasDocuments.activeId) {
      const active=canvasDocumentsCurrent();active.feedback=mcpRuntime.feedback;active.feedbackSequence=mcpRuntime.feedbackSequence;
      for(const doc of canvasDocuments.records.values())doc.sessions=canvasDocumentsWorkspaceData(doc).sessions;
      canvasDocumentsSyncExtension(active);
    }
    mcpRuntime.generation++;
    clearTimeout(mcpRuntime.layoutTimer);mcpRuntime.layoutTimer=0;mcpRuntime.layoutSince=0;mcpRuntime.pendingView.clear();mcpRuntime.viewPaused=false;
    clearTimeout(mcpRuntime.heartbeatTimer);clearTimeout(mcpRuntime.glowTimer);
    mcpRuntime.heartbeatTimer=0;mcpRuntime.glowTimer=0;mcpRuntime.ready=false;mcpRuntime.heartbeatSupported=false;mcpRuntime.connectionLost=lost;mcpRuntime.activeMutation=null;mcpRuntime.mutationDocumentId=null;mcpRuntime.glowing=false;
    for (const controller of mcpRuntime.controllers.values()) controller.abort();
    mcpRuntime.controllers.clear();
    for(const widget of mcpRuntime.previews.values())unmountWidget(widget);mcpRuntime.previews.clear();
    const socket=mcpRuntime.socket; mcpRuntime.socket=null; socket?.close();
    mcpRuntime.sessions.clear();
    mcpRuntime.feedback=[];
    mcpRenderSettings();
    if(mcpRuntime.toolbarManaged&&(!mcpRuntime.toolbarPending||lost))setStatus(mcpText(lost?"toolbarRetry":"disconnected"));
  }
  function mcpRenderCanvasStatus() {
    const connected=mcpRuntime.ready&&mcpRuntime.socket?.readyState===WebSocket.OPEN,
      sessions=[...mcpRuntime.sessions.values()].filter(session=>!session.closed&&mcpSessionVisible(session)),
      clients=[...new Set(sessions.map(session=>session.client||"AI"))],
      mutationVisible=!mcpRuntime.mutationDocumentId||typeof canvasDocuments==="undefined"||mcpRuntime.mutationDocumentId===canvasDocuments.activeId,
      notice=mcpEl("mcpCanvasNotice"),ring=mcpEl("mcpCanvasRing"),button=mcpEl("mcpCanvasNoticeButton");
    if(notice)notice.hidden=!mcpLocal()||(!connected&&!mcpRuntime.connectionLost);
    if(ring){ring.hidden=!connected;ring.setAttribute("data-state",mcpRuntime.glowing&&mutationVisible?"updating":"open");}
    const newButton=mcpEl("mcpShowNewContent"),count=[...mcpRuntime.pendingView].filter(([id])=>mcpSessionVisible(mcpRuntime.sessions.get(id))).reduce((sum,[,ids])=>sum+ids.size,0);
    if(newButton){newButton.hidden=!connected||!count;newButton.textContent=mcpText("newContent");}
    let label=mcpText("canvasLost");
    if(connected)label=mcpRuntime.activeMutation&&mutationVisible?`${mcpRuntime.activeMutation} ${mcpText("canvasApplying")}`:sessions.length?`MCP · ${clients.slice(0,2).join(" / ")}${clients.length>2?" +":""} · ${sessions.length} ${mcpText(sessions.length===1?"canvasSession":"canvasSessions")}`:mcpText("canvasWaiting");
    if(button){if(button.textContent!==label)button.textContent=label;button.title=mcpText("canvasNoticeHelp");}
  }
  // PenEcho owns deterministic placement and camera batching; MCP clients provide only content.
  function mcpSessionVisible(session) {
    return Boolean(session)&&(!session.documentId||typeof canvasDocuments==="undefined"||session.documentId===canvasDocuments.activeId);
  }
  function mcpTaskBounds(session,ids=null) {
    let region=null;
    for(const id of ids||[session.boardObjectId,...[...session.artifacts.values()].flatMap(item=>item.objectIds||[item.objectId])]){
      const doc=typeof canvasDocuments!=="undefined"&&canvasDocuments.records.get(session.documentId),object=doc?canvasDocumentsObject(doc,id):canvasAgentObject(id);if(object)region=unionDirtyBounds(region,doc?canvasDocumentsBounds(object):canvasAgentBox(object));
    }
    return region;
  }
  const MCP_PRESENTATION_SIZES = {base:[480,360],wide:[992,360],tall:[480,752],large:[992,752],page:[1200,800]};
  function mcpPresentation(args,previous=null) {
    const input=args.presentation||previous?.presentation||{},intent=input.intent||"deliver",role=input.role||"primary";
    return {...input,intent,role,attention:input.attention||(intent==="review"?"request":role!=="primary"||intent==="inspect"?"quiet":"normal")};
  }
  function mcpPresentationSize(args) {
    const size=MCP_PRESENTATION_SIZES[args.presentation?.size||"base"]||MCP_PRESENTATION_SIZES.base;
    return {width:args.width||size[0],height:args.height||size[1]};
  }
  // Semantic placement has one owner for visible and parked documents. It never
  // changes existing geometry, and searches downwards instead of a 4608px shelf.
  function mcpArrange(width,height,session,presentation,view,boundsFor,collisions) {
    const gap=32,p= presentation||{},owned=[...(session?.artifacts.values()||[])],
      anchor=p.relativeTo?session?.artifacts.get(p.relativeTo):null;
    if(p.relativeTo&&!anchor)throw Error("Related artifact not found in this session. Use an existing artifactId.");
    const reference=anchor?boundsFor(anchor):null;
    if(anchor&&!reference)throw Error("Related artifact was removed. Choose an existing artifact.");
    const primary=owned.find(a=>a.presentation?.role!=="supporting"&&a.presentation?.role!=="alternative"),
      primaryBounds=primary&&boundsFor(primary),last=owned.map(boundsFor).filter(Boolean).at(-1),
      viewport=view||{x:0,y:0,w:1280,h:900},
      origin={x:Math.max(48,Math.min(SIZE-width-48,viewport.x+Math.max(48,(viewport.w-width)/2))),y:Math.max(128,Math.min(SIZE-height-48,viewport.y+Math.min(160,viewport.h*.18)))};
    let x=reference?.x??primaryBounds?.x??last?.x??origin.x,
      y=reference?reference.y+reference.h+gap:last?last.y+last.h+gap:origin.y;
    const beside=reference&&(p.relation==="beside"||!p.relation&&p.intent==="compare");
    if(beside&&reference.w+gap+width<=Math.max(width,(viewport.readableWidth||viewport.w)-96)) {x=reference.x+reference.w+gap;y=reference.y;}
    x=Math.max(48,Math.min(SIZE-width-48,x));
    for(let attempt=0;attempt<2048&&y+height<=SIZE-48;attempt++) {
      const hits=collisions({x:x-gap/2,y:y-gap/2,w:width+gap,h:height+gap});
      if(!hits.length)return {placement:{mode:"absolute",x,y},layout:{zone:{x,y,w:width,h:height},x:0,y:height+gap,rowHeight:height}};
      y=Math.max(y+gap,...hits.map(b=>b.y+b.h+gap));
    }
    throw Error("No clear space remains below this work. Move the group or use another Canvas.");
  }
  function mcpPlanPlacement(width,height,session=null,presentation=null) {
    if(typeof canvasDocumentsCurrent==="function")return canvasDocumentsPlace(canvasDocumentsCurrent(),width,height,session,presentation);
    const occupied=canvasAgentAllObjects().map(item=>canvasAgentInternalRect(item.box)),ink=visibleInkBounds({x:0,y:0,w:SIZE,h:SIZE});if(ink)occupied.push(ink);
    return mcpArrange(width,height,session,presentation,typeof viewportRect==="function"?viewportRect():null,a=>mcpTaskBounds(session,a.objectIds||[a.objectId]),box=>occupied.filter(b=>intersection(box,b)));
  }
  function mcpContentUpdateRegion(result,args) {
    const doc=canvasDocuments.records.get(result.documentId);
    if(!doc)return null;
    const ids=result.objectIds?[...result.objectIds]:[result.objectId||args.objectId];
    if(args.path?.startsWith("objects/")) {
      try {ids.push(decodeURIComponent(args.path.split("/")[1]));} catch {}
    }
    let region=null;
    for(const id of new Set(ids.filter(Boolean))) {
      const object=canvasDocumentsObject(doc,id);
      if(object)region=unionDirtyBounds(region,canvasDocumentsBounds(object));
    }
    if(!region&&args.region)region={x:args.region.x,y:args.region.y,w:args.region.w,h:args.region.h};
    return region&&[region.x,region.y,region.w,region.h].every(Number.isFinite)&&region.w>0&&region.h>0?region:null;
  }
  function mcpViewBlockedBy() {
    if(document.hidden)return "page-hidden";
    if(state.navigationLocked)return "navigation-locked";
    // pointers also caches hover positions; only the navigation set tracks
    // pressed Canvas pointers and is released globally on pointerup/cancel.
    if(state.trackpadGesture||state.navigationDeadline>performance.now())return "active-navigation";
    if(state.drawing||state.panGesture||state.touchGesture||state.widgetGesture||state.imageGesture||state.selectionGesture||state.animationGesture||state.canvasAgentNavigationPointerIds?.size)return "active-gesture";
    if(state.textEditors?.size)return "text-editing";
    if(document.activeElement?.tagName==="IFRAME")return "widget-interaction";
    if(mcpEl("settingsLayer")?.hidden===false)return "settings-open";
    return null;
  }
  function mcpViewBusy() {return Boolean(mcpViewBlockedBy());}
  // Bounded metadata, computed only on inspection; no capture, DOM scan or timer.
  function mcpAttentionState(session) {
    return {pendingObjects:mcpRuntime.pendingView.get(session.sessionId)?.size||0,paused:mcpRuntime.viewPaused,blockedBy:mcpRuntime.queued>1?"canvas-queue":mcpViewBlockedBy(),canvasScale:state.scale||1};
  }
  function mcpPauseView() {
    if(!mcpRuntime.socket)return;
    mcpRuntime.viewPaused=true;clearTimeout(mcpRuntime.layoutTimer);mcpRuntime.layoutTimer=0;mcpRenderCanvasStatus();
  }
  function mcpQueueView(session,widget,presentation=null) {
    if(presentation?.attention==="quiet"||presentation?.intent==="inspect")return;
    if(!mcpRuntime.ready||mcpRuntime.socket?.readyState!==WebSocket.OPEN)return;
    let pending=mcpRuntime.pendingView.get(session.sessionId);
    if(!pending){pending=new Set();mcpRuntime.pendingView.set(session.sessionId,pending);}
    pending.add(widget.id);
    if(!mcpRuntime.layoutSince)mcpRuntime.layoutSince=Date.now();
    clearTimeout(mcpRuntime.layoutTimer);
    if(!mcpRuntime.viewPaused)mcpRuntime.layoutTimer=setTimeout(()=>mcpFlushView(false),Math.max(0,Math.min(900,2500-(Date.now()-mcpRuntime.layoutSince))));
    mcpRenderCanvasStatus();
  }
  function mcpFlushView(explicit=false) {
    clearTimeout(mcpRuntime.layoutTimer);mcpRuntime.layoutTimer=0;
    if(!mcpRuntime.ready||!mcpRuntime.pendingView.size)return;
    if(mcpRuntime.queued){mcpRuntime.layoutTimer=setTimeout(()=>mcpFlushView(explicit),150);return;}
    if(mcpViewBusy()||(!explicit&&mcpRuntime.viewPaused)){mcpRuntime.viewPaused=true;mcpRenderCanvasStatus();return;}
    const groups=[...mcpRuntime.pendingView].filter(([id])=>mcpSessionVisible(mcpRuntime.sessions.get(id)));
    if(!groups.length){mcpRenderCanvasStatus();return;}
    const candidates=groups.flatMap(([id,ids])=>{
      const session=mcpRuntime.sessions.get(id),seen=new Set(),items=[];
      for(const objectId of ids){
        const artifact=[...session.artifacts.values()].find(a=>(a.objectIds||[a.objectId]).includes(objectId)),key=artifact||objectId;
        if(seen.has(key))continue;seen.add(key);
        const objectIds=artifact?(artifact.objectIds||[artifact.objectId]):[objectId],p=artifact?.presentation||{};
        items.push({id,objectIds:objectIds.filter(value=>ids.has(value)),bounds:mcpTaskBounds(session,objectIds),rank:p.attention==="request"?3:p.role==="supporting"||p.role==="alternative"?1:2});
      }
      return items;
    }).filter(item=>item.bounds).sort((a,b)=>b.rank-a.rank);
    if(!candidates.length){for(const [id] of groups)mcpRuntime.pendingView.delete(id);mcpRenderCanvasStatus();return;}
    let shown=candidates,region=candidates.reduce((bounds,item)=>unionDirtyBounds(bounds,item.bounds),null);
    if(canvasAgentFramePlan(region,96).scale<.65){shown=[candidates[0]];region=shown[0].bounds;}
    const view=typeof viewportRect==="function"?viewportRect():null,stage=canvasAgentFramePlan(region,96).stage,scale=state.scale||1,
      screenX=(state.panX||0)+region.x*scale,screenY=(state.panY||0)+region.y*scale,
      unobscured=!stage||screenX>=stage.x+24&&screenY>=stage.y+24&&screenX+region.w*scale<=stage.x+stage.w-24&&screenY+region.h*scale<=stage.y+stage.h-24,
      alreadyVisible=scale>=.65&&unobscured&&view&&region.x>=view.x+24&&region.y>=view.y+24&&region.x+region.w<=view.x+view.w-24&&region.y+region.h<=view.y+view.h-24;
    // An explicit reveal is a request to focus, even if an overview already
    // contains the artifact at a scale too small for reading its content.
    if(explicit||!alreadyVisible) {
      if(!explicit&&canvasAgentFramePlan(region,96).scale<.5){mcpRuntime.viewPaused=true;mcpRenderCanvasStatus();return;}
      canvasAgentFrameRegion(region,96);
    }
    for(const item of shown){const ids=mcpRuntime.pendingView.get(item.id);for(const objectId of item.objectIds)ids?.delete(objectId);if(!ids?.size)mcpRuntime.pendingView.delete(item.id);}

    mcpRuntime.layoutSince=0;mcpRuntime.viewPaused=false;mcpRenderCanvasStatus();
  }

  function mcpHeartbeat(socket) {
    if(socket!==mcpRuntime.socket)return;
    if(!document.hidden&&(!mcpRuntime.ready||mcpRuntime.heartbeatSupported)&&Date.now()-mcpRuntime.lastPong>45000){mcpDisconnect(true);return;}
    if(socket.readyState===WebSocket.OPEN&&mcpRuntime.ready&&mcpRuntime.heartbeatSupported){try{socket.send(JSON.stringify({type:"ping"}));}catch{mcpDisconnect(true);return;}}
    mcpRuntime.heartbeatTimer=setTimeout(()=>mcpHeartbeat(socket),15000);
  }
  function mcpBeginMutation(client,documentId=null) {
    clearTimeout(mcpRuntime.glowTimer);mcpRuntime.activeMutation=client||"AI";mcpRuntime.mutationDocumentId=documentId;mcpRuntime.glowing=true;mcpRenderCanvasStatus();
  }
  function mcpEndMutation() {
    mcpRuntime.activeMutation=null;mcpRenderCanvasStatus();
    mcpRuntime.glowTimer=setTimeout(()=>{mcpRuntime.glowing=false;mcpRuntime.glowTimer=0;mcpRenderCanvasStatus();},650);
  }
  function mcpRenderSettings() {
    if(!mcpRuntime)return;
    document.querySelectorAll("[data-mcp-label]").forEach(node=>{const key=node.dataset.mcpLabel,text=mcpText(key);
      node.textContent=text;
      if(/^example.*Prompt$/.test(key)){
        node.replaceChildren(...text.split(/(penecho|echo|canvas|画布)/gi).filter(Boolean).map(part=>{
          if(!/^(penecho|echo|canvas|画布)$/i.test(part))return document.createTextNode(part);
          const strong=document.createElement("b");strong.textContent=part;return strong;
        }));
      }});
    document.querySelectorAll("[data-mcp-aria]").forEach(node=>{node.setAttribute("aria-label",mcpText(node.dataset.mcpAria));});
    const connected=mcpRuntime.ready&&mcpRuntime.socket?.readyState===WebSocket.OPEN, connecting=!!mcpRuntime.socket&&!connected;
    mcpRenderCanvasStatus();mcpRenderToolbar();
    if(mcpEl("mcpEnabled")){mcpEl("mcpEnabled").setAttribute("aria-checked",String(connected||connecting));mcpEl("mcpEnabled").classList.toggle("on",connected||connecting);mcpEl("mcpEnabled").disabled=!mcpLocal();}
    const connection=mcpEl("mcpConnectionStatus");
    if(connection){
      connection.textContent=mcpText(!mcpLocal()?"localOnly":connected?"connected":connecting?"connecting":mcpRuntime.connectionLost?"toolbarRetry":"disconnected");
      connection.dataset.state=!mcpLocal()?"off":connected?"on":connecting?"pending":mcpRuntime.connectionLost?"error":"off";
    }
    const remote=mcpRemoteBrowser(),config=remote?null:mcpRuntime.status?.config;
    for(const id of ["mcpClients","mcpManual"])if(mcpEl(id))mcpEl(id).hidden=false;
    if(mcpEl("mcpConfig"))mcpEl("mcpConfig").hidden=remote;
    if(mcpEl("mcpManualSteps"))mcpEl("mcpManualSteps").textContent=mcpText(remote?"remoteManualSteps":"manualSteps");
    const setupHint=document.querySelectorAll('[data-mcp-label="setupHint"]');
    for(const node of setupHint)node.textContent=mcpText(remote?"remoteSetup":"setupHint");
    const configStatus=mcpEl("mcpConfigStatus");
    if(configStatus){configStatus.hidden=!mcpRuntime.loading&&!mcpRuntime.loadError;configStatus.textContent=mcpRuntime.loading?mcpText("loadingConfig"):mcpRuntime.loadError?mcpConfigurationErrorText(mcpRuntime.loadError):"";}
    if(mcpEl("mcpConfig"))mcpEl("mcpConfig").textContent=config?JSON.stringify({mcpServers:{penecho:config}},null,2):"";
    for(const id of ["mcpCopyConfig","mcpCopyInstructions","mcpConfigure"])if(mcpEl(id))mcpEl(id).disabled=!config;
    if(mcpEl("mcpConfigure")&&mcpRuntime.configuring)mcpEl("mcpConfigure").disabled=true;
    if(mcpEl("mcpConfigure")){mcpEl("mcpConfigure").textContent=mcpText(mcpRuntime.configuring?"configuring":"configure");mcpEl("mcpConfigure").setAttribute("aria-busy",String(mcpRuntime.configuring));}
    for(const input of mcpClientInputs)input.disabled=remote||mcpRuntime.configuring;
    const configureNotice=mcpEl("mcpConfigureStatus"),outcome=mcpRuntime.configureResult;
    if(configureNotice){
      configureNotice.hidden=!mcpRuntime.configuring&&!outcome;
      configureNotice.classList.toggle("success",!mcpRuntime.configuring&&outcome?.kind==="saved");
      configureNotice.classList.toggle("error",!mcpRuntime.configuring&&outcome?.kind==="failed");
      configureNotice.textContent=mcpRuntime.configuring?mcpText("configurePending"):outcome?`${outcome.client} · ${mcpText({saved:"configureSaved",existing:"configureExisting",failed:"configureFailed",uncertain:"configureUncertain"}[outcome.kind])}\n${mcpText({saved:"configured",existing:"configureExistingHelp",failed:"configureFailedHelp",uncertain:"configureUncertainHelp"}[outcome.kind])}${outcome.detail?`\n${outcome.detail}`:""}`:"";
    }
    if(mcpEl("mcpConfigure"))mcpEl("mcpConfigure").hidden=mcpSelectedClient()==="other";
  }
  function mcpRememberSetup() {
    mcpRuntime.setupKnown=true;
    try{localStorage.setItem("penecho-mcp-setup-completed","true");}catch{}
  }
  function mcpSetupKnown() {
    if(mcpRuntime.setupKnown)return true;
    try{return localStorage.getItem("penecho-mcp-setup-completed")==="true";}catch{return false;}
  }
  async function mcpToolbarClick() {
    if(mcpRuntime.toolbarChecking)return;
    if(mcpRuntime.socket){
      if(mcpRuntime.ready)mcpRememberSetup();
      mcpRuntime.toolbarManaged=false;mcpRuntime.toolbarPending=false;mcpDisconnect();setStatus(mcpText("disconnected"));return;
    }
    if(!mcpLocal()){openSettings();selectSettingsPage("mcp");return;}
    if(!mcpSetupKnown()&&!mcpRemoteBrowser()) {
      const generation=mcpRuntime.generation;
      mcpRuntime.toolbarChecking=true;setStatus(mcpText("checkingSetup"));mcpRenderToolbar();
      try{
        const result=await mcpApi("status?inspectClients=1");
        if(generation!==mcpRuntime.generation)return;
        mcpRuntime.status=result;mcpRuntime.loadError=null;
        if(Array.isArray(result.configuredClients)&&result.configuredClients.some(client=>["codex","claude"].includes(client)))mcpRememberSetup();
      }catch(error){mcpRuntime.loadError=error;mcpRuntime.connectionLost=true;setStatus(mcpText("toolbarRetry"));return;}finally{mcpRuntime.toolbarChecking=false;mcpRenderSettings();}
      if(generation!==mcpRuntime.generation)return;
      if(!mcpSetupKnown()&&!mcpRemoteBrowser()){openSettings();selectSettingsPage("mcp");return;}
    }
    mcpRuntime.toolbarManaged=true;mcpRuntime.toolbarPending=true;setStatus(mcpText("connecting"));
    try{mcpConnect();}catch{mcpDisconnect(true);setStatus(mcpText("toolbarRetry"));mcpRenderSettings();}
  }
  function mcpRenderToolbar() {
    window.PenEchoStudioNavigator?.syncMcp?.(Boolean(mcpRuntime.socket));
    const button=mcpEl("mcpToolbarToggle");if(!button)return;
    const connected=mcpRuntime.ready&&mcpRuntime.socket?.readyState===WebSocket.OPEN,opening=Boolean(mcpRuntime.socket)&&!connected;
    button.setAttribute("aria-pressed",String(connected||opening));button.setAttribute("aria-busy",String(opening||Boolean(mcpRuntime.toolbarChecking)));button.disabled=Boolean(mcpRuntime.toolbarChecking);
    const title=mcpText(connected||opening?"toolbarClose":mcpRuntime.connectionLost?"toolbarRetry":(mcpSetupKnown()||mcpRemoteBrowser())?"toolbarOpen":"toolbarSetup");
    button.title=title;button.setAttribute("aria-label",`MCP Server · ${title}`);
    button.setAttribute("data-state",connected?"connected":opening||mcpRuntime.toolbarChecking?"connecting":mcpRuntime.connectionLost?"failed":"off");
    if(mcpRuntime.toolbarPending&&(connected||mcpRuntime.connectionLost)){
      setStatus(mcpText(connected?"connected":"toolbarRetry"));mcpRuntime.toolbarPending=false;
    }
  }
  function mcpConfigurationErrorText(error) {
    if(["device_offline","linked_device_required","device_timeout"].includes(error.code))return mcpText("deviceOffline");
    if(["mcp_update_required","remote_mcp_unsupported","device_mcp_unsupported","linked_device_update_required"].includes(error.code))return mcpText("deviceUpdate");
    if(error.code==="local_host_required")return mcpText("hostRequired");
    if([404,405].includes(error.status)||error.code==="mcp_configuration_unavailable")return mcpText("serviceOutdated");
    if([401,403].includes(error.status))return mcpText("accessDenied");
    return mcpText("loadFailed");
  }
  async function mcpApi(path,body={}) {
    const response=await fetch(`/api/mcp/${path}`,{method:"POST",headers:authenticatedApiHeaders({"Content-Type":"application/json"}),credentials:"same-origin",cache:"no-store",body:JSON.stringify(body),signal:AbortSignal.timeout(path==="configure"?20000:5000)});
    const result=await response.json().catch(()=>null);
    if(!response.ok||!result||typeof result!=="object")throw Object.assign(Error(typeof result?.error==="string"?result.error:result?.error?.message||"MCP request failed."),{status:response.status,code:result?.error?.code||result?.code||(typeof result?.error==="string"?result.error:undefined),existing:result?.existing===true});
    return result;
  }
  async function mcpRefreshSettings() {
    if(!mcpLocal()||mcpRuntime.loading){mcpRenderSettings();return mcpRuntime.loading;}
    mcpRuntime.loadError=null;
    mcpRuntime.loading=(async()=>{
      try{
        const status=await mcpApi("status"),config=status.config;
        if(status.canConfigureLocalClients!==false&&(!config||typeof config.command!=="string"||!config.command.trim()||!Array.isArray(config.args)||config.args.some(arg=>typeof arg!=="string")))throw Object.assign(Error("MCP configuration is unavailable."),{code:"mcp_configuration_unavailable"});
        mcpRuntime.status=status;
      }catch(error){mcpRuntime.status=null;mcpRuntime.loadError=error;}
      finally{mcpRuntime.loading=null;mcpRenderSettings();}
    })();
    mcpRenderSettings();return mcpRuntime.loading;
  }
  function mcpInstructions() {
    return `Configure PenEcho MCP for the AI client I am using. Read its installed MCP help or official documentation. Preserve unrelated servers and settings; do not invent client commands. Use this exact stdio launch configuration (absolute paths and env matter):\n${JSON.stringify({mcpServers:{penecho:mcpRuntime.status?.config}},null,2)}\nNo server URL, port, API key or npm download is needed. This bridge discovers local PenEcho instances. Reload the client and verify penecho_list_canvases appears. If no canvas is listed, ask me to open PenEcho Settings → MCP service and allow this canvas. Select the intended instanceId and canvasId explicitly, then penecho_start_session with a descriptive title, client name and a unique sessionKey for this conversation. Each conversation must use its own sessionId. Retain the returned documentId across reconnects. Only a new, unbound conversation gets a new Canvas by default, even if the visible Canvas is empty. Give the new Canvas a concise descriptive name through title. Continue an already bound conversation on its retained documentId/sessionId across turns and reconnects; do not create another Canvas. Pass documentId explicitly only to resume known existing work or when the user requests that Canvas. When I say current canvas, this canvas, 当前画布 or 这个画布, use penecho_start_session target:"current" without documentId to attach the visible Canvas directly; do not create or open a Canvas first. Keep its returned sessionId and documentId pinned. If this conversation is already bound elsewhere, use a distinct stable attachment sessionKey and keep the original handle. Read existing content before editing. For native brush annotations, use penecho_edit_canvas action:"draw_ink" with current baseRevision and strokes containing world-coordinate points, arbitrary explicit #RRGGBB color, and width 1–64. It preserves the selected user brush and supports the active document only; never switch a background document into view without intent. Limits: 16 strokes, 256 points each, 1024 total points within 2048 × 2048; brush radius must stay inside the Canvas. Use penecho_find_canvases to resolve saved IDs across Device, Server and connected Cloud; an unavailable store is not a missing document. Use an exact locator if copies are ambiguous. Open uses show:false by default, so background work never steals the viewport. List/read virtual files before patching: use the returned contentHash, one unified patch and a stable requestId; retry the same requestId after an uncertain result. Keep context.md concise with the goal, decisions and next step. Use runtime/viewport.json and runtime/selection.json only as current context. Read penecho_read_messages at natural task boundaries, acknowledge received/working/done/error explicitly and deduplicate instruction IDs across retries. Reading does not acknowledge; queued instructions cannot wake this client. The external processor pauses local Auto AI and never silently falls back to another model. Widget controls may opt in with data-penecho-action and data-penecho-prompt; only a trusted click queues a text instruction for the owning conversation. Width and height apply on creation; later HTML updates preserve geometry. Use penecho_edit_canvas for explicit geometry changes.\nWith an already selected live connection, proactively show useful UI previews, a small set of alternatives for user choice, or a diagram when it clarifies the task. Avoid decorative output for routine edits. Update stable artifacts and keep ordinary presentation capture:false: generating a screenshot does not call a model, but a model reading that image may incur image-input tokens. While doing my real work, use concise session status only when useful information changes; keep a stable main artifact, use presentation intent and standard sizes, and use inspect with capture:true for temporary render checks. Never publish private chain of thought, secrets or full transcripts. Do not update per token or every tool call. Keep the primary task moving if visualization is offline. Use penecho_draw for lightweight native text, shapes, connectors or paths, and penecho_plot for function expressions. Nodes can omit local positions; PenEcho handles placement. Draw items are a complete artifact replacement, so retain all desired element IDs. Shapes and paths are native image objects, not editable vector handles or eraser-layer strokes. Both tools support capture:true for bounded visual verification. Use penecho_present_widget with a stable artifactId for interactive HTML UI previews. When presenting code that needs immediate visual validation, use penecho_present_widget with capture:true in one call. Otherwise use penecho_capture_widget only when visual validation is needed; read the image and timing/diagnostics. It is an embedded Widget preview, not full browser navigation or end-to-end automation. Before revising a design, call penecho_read_feedback for your session. Keep an independent after cursor, page with nextCursor while hasMore, and advance only after processing. Feedback defaults to one compressed screenshot with nearby design context, including text-only feedback. Read the image; use capture:false only for a lightweight availability check. Never discard unread feedback by replacing your cursor with a newer presentation feedbackCursor. Reads do not clear Canvas dirty state or other sessions. Handle truncated history explicitly. Only committed user input after the session was established is available; no automatic wake-up or tight polling. Finish with status done or error and a short verified result. Do not claim a tool succeeded without its result.\n${mcpRuntime.status?.instructions||""}`;
  }
  function mcpConnect() {
    if(!mcpLocal())return;
    mcpDisconnect();
    if(typeof canvasDocumentsReady==="function")void canvasDocumentsReady().then(()=>{const doc=canvasDocumentsCurrent();mcpRuntime.feedback=doc.feedback;mcpRuntime.feedbackSequence=doc.feedbackSequence;canvasDocumentsRender();}).catch(error=>canvasDocumentsReport(error,()=>canvasDocumentsReady()));
    const socket=new WebSocket(`${location.protocol==="https:"?"wss:":"ws:"}//${location.host}${window.PENECHO_CONFIG?.runtime==="cloud"?"/api/v1/remote-canvas/mcp":"/api/mcp/canvas"}`),generation=mcpRuntime.generation;
    mcpRuntime.socket=socket;mcpRuntime.lastPong=Date.now();mcpHeartbeat(socket);
    socket.addEventListener("open",()=>{if(socket!==mcpRuntime.socket)return;socket.send(JSON.stringify({type:"hello",canvasId:canvasClientId(),title:state.currentSnapshotName||"PenEcho Canvas"}));mcpRenderSettings();});
    socket.addEventListener("message",event=>{
      if(socket!==mcpRuntime.socket)return;let message;try{message=JSON.parse(event.data);}catch{return;}
      if(message.type==="ready"){mcpRuntime.ready=true;mcpRuntime.connectionLost=false;mcpRuntime.heartbeatSupported=message.heartbeat===true;mcpRuntime.lastPong=Date.now();mcpRenderSettings();if(typeof canvasDocuments!=="undefined"){canvasDocuments.error=null;canvasDocuments.retry=null;canvasDocumentsRender();}return;}
      if(message.type==="pong"){mcpRuntime.lastPong=Date.now();return;}
      if(message.type==="cancel"){mcpRuntime.controllers.get(message.requestId)?.abort();return;}
      if(message.type!=="call")return;
      if(mcpRuntime.queued>=32){socket.send(JSON.stringify({type:"result",requestId:message.requestId,ok:false,error:{code:"CANVAS_BUSY",message:"Canvas update queue is full."}}));return;}
      const controller=new AbortController();mcpRuntime.controllers.set(message.requestId,controller);mcpRuntime.queued++;
      const execution={kind:"mcp",socket,generation,controller,preserveView:true};
      mcpRuntime.queue=mcpRuntime.queue.catch(()=>{}).then(async()=>{
        const started=performance.now(),mutation=["mcp_start_session","mcp_update_session","mcp_present_widget","mcp_draw","mcp_plot","mcp_close_session"].includes(message.name)&&message.arguments?.presentation?.intent!=="inspect";
        try{
          canvasAgentAssertToolExecution(execution);
          if(mutation)mcpBeginMutation(message.arguments?.client||mcpRuntime.sessions.get(message.arguments?.sessionId)?.client,message.arguments?.documentId||mcpRuntime.sessions.get(message.arguments?.sessionId)?.documentId||null);
          const previousRegion=message.name==="mcp_edit_canvas"&&message.arguments?.action==="delete"?mcpContentUpdateRegion({documentId:message.arguments.documentId||mcpRuntime.sessions.get(message.arguments.sessionId)?.documentId},message.arguments):null;
          const result=typeof canvasDocumentsExecute==="function"?await canvasDocumentsExecute(message.name,message.arguments||{},execution):await mcpExecute(message.name,message.arguments||{},execution);
          canvasAgentAssertToolExecution(execution);
          if(["mcp_present_widget","mcp_draw","mcp_plot","mcp_apply_patch","mcp_edit_canvas"].includes(message.name)&&message.arguments?.presentation?.intent!=="inspect"&&message.arguments?.action!=="show"&&!result.reused){
            const region=mcpContentUpdateRegion(result,message.arguments||{})||previousRegion;
            window.PenEchoStudioNavigator?.noteMcpContentUpdate?.(result.documentId,region);
          }
          if(mutation){const session=mcpRuntime.sessions.get(message.arguments?.sessionId);if(session)session.updatedAt=Date.now();}
          socket.send(JSON.stringify({type:"result",requestId:message.requestId,ok:true,result:{...result,browserElapsedMs:Math.round(performance.now()-started)}}));
        }catch(error){if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:"result",requestId:message.requestId,ok:false,error:{code:error.code||"CANVAS_TOOL_FAILED",message:String(error.message||error),...(error.details?{details:error.details}:{})}}));}
        finally{mcpRuntime.queued--;mcpRuntime.controllers.delete(message.requestId);if(mutation&&socket===mcpRuntime.socket){mcpEndMutation();mcpRenderSettings();}if(socket===mcpRuntime.socket)await window.PenEchoStudioNavigator?.flushMcpFollow?.();}
      });
    });
    socket.addEventListener("close",()=>{if(socket===mcpRuntime.socket)mcpDisconnect(true);});
    socket.addEventListener("error",()=>{if(socket===mcpRuntime.socket)mcpDisconnect(true);});
    mcpRenderSettings();
  }
  function mcpEscape(text) { return String(text??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
  // Record committed user input only. Never scan pixels or consume Canvas dirty state here.
  function mcpRecordFeedback(kind,bounds,item=null) {
    if(!mcpRuntime||(!mcpRuntime.socket&&!(typeof canvasDocumentsExternal==="function"&&canvasDocumentsExternal()))||!bounds)return;
    if(![bounds.x,bounds.y,bounds.w,bounds.h].every(Number.isFinite))return;
    const entry={cursor:++mcpRuntime.feedbackSequence,kind,bounds:{x:bounds.x,y:bounds.y,w:Math.max(1,bounds.w),h:Math.max(1,bounds.h)},createdAt:Date.now()};
    if(item?.id)entry.objectId=String(item.id);
    if(kind==="text"){entry.text=String(item?.text||"").slice(0,4000);entry.textTruncated=String(item?.text||"").length>4000;}
    mcpRuntime.feedback.push(entry);
    if(mcpRuntime.feedback.length>200)mcpRuntime.feedback.splice(0,mcpRuntime.feedback.length-200);
    if(typeof canvasDocumentsCurrent==="function"){const doc=canvasDocumentsCurrent();doc.feedback=mcpRuntime.feedback;doc.feedbackSequence=mcpRuntime.feedbackSequence;doc.changes.push({cursor:++doc.changeSequence,kind,objectId:item?.id||null,bounds:entry.bounds,createdAt:entry.createdAt});if(doc.changes.length>200)doc.changes.shift();}
  }
  async function mcpReadFeedback(session,args,execution) {
    const after=Math.max(session.feedbackStart,args.after??session.feedbackStart),latestCursor=mcpRuntime.feedbackSequence;
    if(!Number.isSafeInteger(after)||after>latestCursor)throw Error("Feedback cursor is invalid for this canvas connection.");
    const pending=mcpRuntime.feedback.filter(entry=>entry.cursor>after),entries=[];
    let dirtyRegion=null;
    for(const entry of pending.slice(0,args.limit??20)){
      const expanded=unionDirtyBounds(dirtyRegion,entry.bounds);
      // Spatial pagination keeps distant remarks readable without skipping their cursors.
      if(entries.length&&Math.max(expanded.w,expanded.h)>2048)break;
      entries.push({...entry,bounds:{...entry.bounds}});dirtyRegion=expanded;
    }
    const result={sessionId:session.sessionId,after,nextCursor:entries.at(-1)?.cursor??after,latestCursor,hasMore:pending.length>entries.length,truncated:after<(mcpRuntime.feedback[0]?.cursor??latestCursor+1)-1,entries};
    if(args.capture===false||!entries.length)return result;
    if(state.drawing)throw Error("Finish the current stroke before capturing feedback, then retry with the same cursor.");
    // Preserve nearby design context, independently of where the user has since panned.
    const margin=120,x=Math.max(0,dirtyRegion.x-margin),y=Math.max(0,dirtyRegion.y-margin),
      region={x,y,width:Math.min(SIZE,dirtyRegion.x+dirtyRegion.w+margin)-x,height:Math.min(SIZE,dirtyRegion.y+dirtyRegion.h+margin)-y};
    const captured=await canvasAgentCapture({target:"region",region,quality:"basic",coordinates:"metadata"},{signal:execution.controller?.signal,assertCurrent:()=>canvasAgentAssertToolExecution(execution)});
    canvasAgentAssertToolExecution(execution);
    if(state.drawing)throw Error("Finish the current stroke before capturing feedback, then retry with the same cursor.");
    return {...result,...captured,visualContext:"current-canvas-with-nearby-design"};
  }

  function mcpProgressData(session) { return {title:session.title,client:session.client,status:session.status,statusLabel:mcpText(session.status),summary:session.summary||"",steps:session.steps||[],events:session.events||[]}; }
  function mcpBoardHtml(session) {
    const data=mcpProgressData(session),json=JSON.stringify(data).replace(/</g,"\\u003c");
    return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
      :root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#24272d;background:#fafafa}*{box-sizing:border-box}body{margin:0;padding:24px;font-size:15px;line-height:1.5;height:100vh;display:flex;flex-direction:column}header{display:flex;gap:16px;align-items:flex-start;border-bottom:1px solid #d9dbde;padding-bottom:18px;flex-shrink:0;max-height:32vh;overflow:auto}h1{font-size:22px;line-height:1.25;margin:0;font-weight:600;overflow-wrap:anywhere}#identity{flex:1;min-width:0}#client{font-size:12px;color:#626973}#status{font-size:12px;white-space:nowrap;color:#0f766e}#summary{margin:18px 0;overflow-wrap:anywhere;max-height:25vh;overflow:auto;flex-shrink:0}main{display:grid;grid-template-columns:1fr 1fr;gap:24px;min-height:0;overflow:auto;flex:1}section{min-width:0}h2{font-size:13px;font-weight:600;margin:0 0 10px;color:#626973}ol,ul{margin:0;padding:0;list-style:none}li{padding:8px 0;border-bottom:1px solid #e8e9eb;overflow-wrap:anywhere}#steps li{display:flex;gap:10px;align-items:baseline}.mark{font-size:12px;flex:0 0 20px;color:#626973}.done .mark{color:#0f766e}.working{font-weight:600}.error .mark{color:#be3434}#events li{font-size:13px}footer{margin-top:18px;font-size:12px;color:#626973}@media(max-width:580px){main{grid-template-columns:1fr}body{padding:18px}header{flex-wrap:wrap}}@media(prefers-color-scheme:dark){:root{color:#e8e9ec;background:#222326}header,li{border-color:#42454b}#client,h2,.mark,footer{color:#adb2bb}#status,.done .mark{color:#70cdb7}}
      </style></head><body><header><div id="identity"><div id="client"></div><h1 id="title"></h1></div><span id="status"></span></header><p id="summary"></p><main><section><h2>${state.language==="zh"?"工作步骤":"Work plan"}</h2><ol id="steps"></ol></section><section><h2>${state.language==="zh"?"最新进展":"Latest progress"}</h2><ul id="events"></ul></section></main><footer>${state.language==="zh"?"外部 AI 提供的计划、进展与结果":"Plans, progress and results shared by your AI"}</footer><script>
      function render(d){for(const k of ['title','client','summary'])document.getElementById(k).textContent=d[k]||'';document.getElementById('status').textContent=d.statusLabel||d.status;const steps=document.getElementById('steps');steps.replaceChildren();(d.steps||[]).forEach((s,i)=>{const li=document.createElement('li'),mark=document.createElement('span'),label=document.createElement('span');li.className=s.status||'';mark.className='mark';mark.textContent=s.status==='done'?'✓':String(i+1);label.textContent=s.label;li.append(mark,label);steps.append(li)});const events=document.getElementById('events');events.replaceChildren();(d.events||[]).slice(-8).forEach(e=>{const li=document.createElement('li');li.textContent=e.text;events.append(li)})}render(${json});addEventListener('message',e=>{if(e.source===parent&&e.data?.type==='penecho-mcp-progress')render(e.data.progress)});
      <\/script></body></html>`;
  }
  function syncMcpWidgetProgress(widget) {
    if(!widget.mcpProgress||!widget.hostReady||widget.renderActive===false||widget.mcpSentVersion===widget.contentVersion)return;
    widget.frame?.contentWindow?.postMessage({type:"penecho-mcp-progress",progress:widget.mcpProgress},widget.hostOrigin||location.origin);
    widget.mcpSentVersion=widget.contentVersion;
  }
  async function mcpCreateWidget(item,execution) {
    const result=await canvasAgentCreate({baseRevision:state.userRevision,items:[{type:"widget",widgetType:"html_widget",pluginId:"general",sourceFormat:"penecho-mcp+html",...item}]},execution);
    return canvasAgentObject(result.receipts[0].objectId).item;
  }
  async function mcpWaitForWidgetLoad(widget,execution) {
    const signal=execution.controller.signal;
    if(!widget.hostReady)await waitForWidgetSnapshot(widget.hostReadyPromise,signal);
    canvasAgentAssertToolExecution(execution);
    widget.renderActive=true;widget.shell?.classList.remove("widget-offscreen");sendWidgetInit(widget);sendWidgetHostState(widget,undefined,undefined,true);
    if(widget.mcpDocumentLoaded)return;
    await new Promise((resolve,reject)=>{
      const finish=()=>{clearTimeout(timer);signal.removeEventListener("abort",abort);widget.mcpLoadWaiters?.delete(finish);resolve();},
        abort=()=>{clearTimeout(timer);widget.mcpLoadWaiters?.delete(finish);reject(Error("Preview load was cancelled."));},
        timer=setTimeout(()=>{signal.removeEventListener("abort",abort);widget.mcpLoadWaiters?.delete(finish);reject(Error("Preview did not finish loading. Check external assets and retry."));},10000);
      (widget.mcpLoadWaiters||=new Set()).add(finish);signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();
    });
  }
  async function mcpCaptureWidget(widget,args,execution) {
      if(!widget.frame?.contentWindow)mountWidget(widget);
      if(!widget.frame?.contentWindow)throw Error("Preview could not be mounted. Check that the General Widget plugin is available.");
      const previousActive=widget.renderActive;
      try {
      await mcpWaitForWidgetLoad(widget,execution);
      const quality=args.quality||"basic",policy=quality==="detail"?CANVAS_AGENT_DETAIL_CAPTURE_POLICY:CANVAS_AGENT_LAYOUT_CAPTURE_POLICY,
        started=performance.now(),snapshot=await requestWidgetSnapshot(widget,WIDGET_SNAPSHOT_TIMEOUT_MS,true,execution.controller.signal,quality==="detail");
      canvasAgentAssertToolExecution(execution);
      const rasterMs=Math.round(performance.now()-started),scale=Math.min(1,policy.maxLongEdge/Math.max(snapshot.width,snapshot.height),Math.sqrt(policy.maxPixels/(snapshot.width*snapshot.height))),canvas=document.createElement("canvas");
      canvas.width=Math.max(1,Math.floor(snapshot.width*scale));canvas.height=Math.max(1,Math.floor(snapshot.height*scale));canvas.getContext("2d").drawImage(snapshot,0,0,canvas.width,canvas.height);
      const encoded=await canvasAgentCompressedCanvas(canvas,policy),dataUrl=await canvasAgentReadDataUrl(encoded.blob);
      canvasAgentAssertToolExecution(execution);
      const result={dataUrl,mediaType:encoded.blob.type,width:encoded.canvas.width,height:encoded.canvas.height,encodedBytes:encoded.blob.size,quality,
        artifactId:args.artifactId,objectId:widget.id,revision:state.userRevision,viewport:{width:widget.contentW,height:widget.contentH},rasterMs,
        runtimeDiagnostics:widget.runtimeDiagnostics||null};
      canvas.width=canvas.height=1;if(encoded.canvas!==canvas)encoded.canvas.width=encoded.canvas.height=1;
      return result;
      } finally { if(previousActive===false){widget.renderActive=false;widget.shell?.classList.add("widget-offscreen");sendWidgetHostState(widget,undefined,undefined,true);} }
  }
  async function mcpInspectHtml(args,execution) {
    const size=mcpPresentationSize(args),id=`mcp-preview-${canvasClientId()}`,
      widget={id,widgetType:"html_widget",pluginId:"general",sourceFormat:"penecho-mcp+html",title:args.title,html:args.html,x:0,y:0,w:size.width,h:size.height,contentW:size.width,contentH:size.height,contentVersion:0,refreshSeconds:0,mcpEphemeral:true};
    mcpRuntime.previews.set(id,widget);
    try {
      canvasAgentAssertToolExecution(execution);mountWidget(widget);
      if(widget.shell){widget.shell.setAttribute("aria-hidden","true");widget.shell.inert=true;Object.assign(widget.shell.style,{position:"fixed",left:"-20000px",top:"0",transform:"none",pointerEvents:"none"});}
      const result=await mcpCaptureWidget(widget,args,execution);
      const {objectId,...capture}=result;
      return {...capture,ephemeral:true,presentation:mcpPresentation(args)};
    } finally {unmountWidget(widget);mcpRuntime.previews.delete(id);widget.snapshotImage=null;widget.snapshotDataUrl="";}
  }
  async function mcpExecute(name,args,execution) {
    if(name==="mcp_start_session"){
      if(mcpRuntime.sessions.has(args.sessionId))return {sessionId:args.sessionId,boardObjectId:mcpRuntime.sessions.get(args.sessionId).boardObjectId,feedbackCursor:mcpRuntime.sessions.get(args.sessionId).feedbackStart};
      const session={sessionId:args.sessionId,title:args.title,client:args.client||"",status:"working",summary:"",steps:[],events:[],artifacts:new Map(),feedbackStart:mcpRuntime.feedbackSequence};
      session.boardObjectId=null;
      mcpRuntime.sessions.set(args.sessionId,session);mcpRenderSettings();
      return {sessionId:args.sessionId,boardObjectId:null,revision:state.userRevision,feedbackCursor:session.feedbackStart};
    }
    const session=mcpRuntime.sessions.get(args.sessionId);if(!session)throw Error("MCP session is no longer connected to this canvas. Start a new session.");
    if(name==="mcp_read_feedback")return mcpReadFeedback(session,args,execution);
    const board=session.boardObjectId&&canvasAgentObject(session.boardObjectId)?.item;
    if(name==="mcp_update_session"){
      for(const key of ["title","status","summary","steps"])if(args[key]!==undefined)session[key]=args[key];
      if(args.events){const events=new Map(session.events.map(event=>[event.id,event]));for(const event of args.events)events.set(event.id,event);session.events=[...events.values()].slice(-40);}
      // Keep legacy user-owned boards usable; new sessions only update metadata.
      if(board){board.html=mcpBoardHtml(session);board.title=session.title;board.mcpProgress=mcpProgressData(session);board.contentVersion=(board.contentVersion||0)+1;
        board.shell?.setAttribute("aria-label",`${session.title}. ${t("widgetRefineHint")}`);if(board.frame)board.frame.title=session.title;
        board.snapshotVersion=-1;state.userRevision++;syncMcpWidgetProgress(board);}
      session.updatedAt=Date.now();
      if(["done","error"].includes(session.status))save();
      mcpRenderSettings();return {applied:true,visible:mcpSessionVisible(session),revision:state.userRevision};
    }
    if(name==="mcp_draw"||name==="mcp_plot")return mcpPresentPrimitives(session,args,name==="mcp_draw"?"drawing":"plot",execution);
    if(name==="mcp_present_widget"){
      if(args.presentation?.intent==="inspect")return mcpInspectHtml(args,execution);
      if(session.artifacts.get(args.artifactId)?.kind)throw Error("This artifact is a drawing or plot. Use its original tool to update it.");
      let artifact=session.artifacts.get(args.artifactId),widget=artifact&&canvasAgentObject(artifact.objectId)?.item;
      const presentation=mcpPresentation(args,artifact),size=mcpPresentationSize(args);
      if(artifact&&!widget)throw Error("This preview was removed. Use a new artifactId to create another.");
      if(widget){
        const context=widgetEditContext(widget,"agent"),expectedHash=await canvasAgentHash(context);
        const command={...context,tool:"html_widget",pluginId:"general",html:args.html,title:args.title,x:widget.x,y:widget.y,w:widget.w,h:widget.h};
        await canvasAgentReplaceWidget({baseRevision:state.userRevision,objectId:widget.id,expectedHash,command},execution);
        // Source updates preserve the user's footprint. Explicit geometry edits use
        // penecho_edit_canvas and its revision/collision checks.
      }else{
        const plan=mcpPlanPlacement(size.width,size.height,session,presentation);
        widget=await mcpCreateWidget({title:args.title,html:args.html,width:size.width,height:size.height,placement:plan.placement},{...execution,preserveView:true});
        session.layout=plan.layout;mcpQueueView(session,widget,presentation);
        artifact={objectId:widget.id,title:args.title};session.artifacts.set(args.artifactId,artifact);
      }
      artifact.title=args.title;artifact.presentation=presentation;
      if(presentation.attention==="request")mcpQueueView(session,widget,presentation);
      return {artifactId:args.artifactId,objectId:widget.id,revision:state.userRevision,feedbackCursor:mcpRuntime.feedbackSequence,viewport:{width:widget.contentW,height:widget.contentH},runtimeDiagnostics:widget.runtimeDiagnostics||null,presentation};
    }
    if(name==="mcp_capture_primitives"){
      const artifact=session.artifacts.get(args.artifactId);
      if(!artifact?.kind)throw Error("Drawing or plot not found in this session.");
      if(state.drawing)throw Error("Finish the current stroke before capturing.");
      const bounds=mcpTaskBounds(session,artifact.objectIds);if(!bounds)throw Error("Drawing was removed.");
      const x=Math.max(0,bounds.x-24),y=Math.max(0,bounds.y-24),region={x,y,width:Math.min(SIZE,bounds.x+bounds.w+24)-x,height:Math.min(SIZE,bounds.y+bounds.h+24)-y};
      const capture=await canvasAgentCapture({target:"region",region,quality:"basic",coordinates:"metadata"},{signal:execution.controller?.signal,assertCurrent:()=>canvasAgentAssertToolExecution(execution)});
      canvasAgentAssertToolExecution(execution);if(state.drawing)throw Error("Finish the current stroke before capturing.");
      return {...capture,artifactId:args.artifactId,revision:state.userRevision};
    }
    if(name==="mcp_capture_widget"){
      const artifact=session.artifacts.get(args.artifactId);if(!artifact)throw Error("Preview not found in this session. Present the Widget first.");
      const object=canvasAgentObject(artifact.objectId);if(!object)throw Error("Preview was removed.");
      if(object.kind!=="widget")throw Error("This tool captures Widgets only. Read user annotations with penecho_read_feedback.");
      return mcpCaptureWidget(object.item,args,execution);
    }
    if(name==="mcp_inspect_session")return {sessionId:session.sessionId,boardObjectId:board?.id||null,...mcpProgressData(session),attention:mcpAttentionState(session),artifacts:[...session.artifacts].map(([artifactId,value])=>{const object=canvasAgentObject(value.objectId);return {artifactId,title:value.title,presentation:value.presentation,kind:value.kind||"widget",objectId:value.objectId,...(value.objectIds?{objectIds:value.objectIds,elements:(value.elements||[]).map(([id,entry])=>{const child=canvasAgentObject(entry.objectId);return {id,objectId:entry.objectId,kind:entry.kind,...(child?{bounds:canvasAgentBox(child)}:{removed:true})};})}:{}),...(object?{bounds:value.objectIds?mcpTaskBounds(session,value.objectIds):canvasAgentBox(object)}:{removed:true})};}),revision:state.userRevision};
    if(name==="mcp_close_session"){session.status="done";await mcpExecute("mcp_update_session",{sessionId:args.sessionId,status:"done"},execution);session.closed=true;mcpRuntime.pendingView.delete(session.sessionId);mcpRenderSettings();return {closed:true,retainedOnCanvas:true};}
    throw Error(`Unsupported MCP Canvas operation: ${name}`);
  }
  mcpEl("mcpToolbarToggle")?.addEventListener("click",mcpToolbarClick);
  mcpEl("mcpEnabled")?.addEventListener("click",event=>{
    if(event.currentTarget.getAttribute("aria-checked")==="true")return mcpDisconnect();
    try{mcpConnect();}catch{mcpDisconnect(true);setStatus(mcpText("toolbarRetry"));}
  });
  mcpEl("mcpCanvasNoticeButton")?.addEventListener("pointerdown",event=>event.stopPropagation());
  mcpEl("mcpCanvasNoticeButton")?.addEventListener("click",event=>{event.stopPropagation();openSettings();selectSettingsPage("mcp");});
  mcpEl("mcpShowNewContent")?.addEventListener("pointerdown",event=>event.stopPropagation());
  mcpEl("mcpShowNewContent")?.addEventListener("click",event=>{event.stopPropagation();mcpFlushView(true);});
  mcpEl("viewport")?.addEventListener("pointerdown",mcpPauseView,{capture:true,passive:true});
  mcpEl("viewport")?.addEventListener("wheel",mcpPauseView,{passive:true});
  mcpEl("viewport")?.addEventListener("keydown",event=>{if([" ","ArrowUp","ArrowDown","ArrowLeft","ArrowRight","+","-","="].includes(event.key))mcpPauseView();});
  mcpEl("mcpRefresh")?.addEventListener("click",()=>void mcpRefreshSettings());
  mcpEl("mcpClients")?.addEventListener("change",()=>{mcpRuntime.configureResult=null;if(mcpEl("mcpManual"))mcpEl("mcpManual").open=mcpSelectedClient()==="other";mcpRenderSettings();});
  for(const [id,instructions] of [["mcpCopyConfig",false],["mcpCopyInstructions",true]])mcpEl(id)?.addEventListener("click",async()=>{
    if(mcpRemoteBrowser()||!mcpRuntime.status?.config)return;
    const copied=await writeClipboardText(instructions?mcpInstructions():JSON.stringify({mcpServers:{penecho:mcpRuntime.status?.config}},null,2));mcpEl("mcpSetupStatus").textContent=copied?mcpText("copied"):t("copyFailed");
  });
  mcpEl("mcpExamples")?.addEventListener("click",async event=>{
    const button=event.target?.closest?.("[data-mcp-example]");
    if(!button)return;
    const copied=await writeClipboardText(mcpText(button.dataset.mcpExample));
    const status=mcpEl("mcpExampleStatus");
    if(status){status.textContent=copied?mcpText("exampleCopied"):t("copyFailed");clearTimeout(mcpRuntime.exampleStatusTimer);mcpRuntime.exampleStatusTimer=setTimeout(()=>{if(status.textContent===mcpText("exampleCopied"))status.textContent="";},2400);}
    if(copied){button.classList.add("done");setTimeout(()=>button.classList.remove("done"),1600);}
  });
  for(const [id,route] of [["mcpCopySkill","skill"],["mcpCopyGuide","guide"]])mcpEl(id)?.addEventListener("click",async()=>{
    try{const result=await mcpApi(route),copied=await writeClipboardText(result.text);mcpEl("mcpSetupStatus").textContent=copied?mcpText("copied"):t("copyFailed");}
    catch(error){mcpEl("mcpSetupStatus").textContent=String(error.message);}
  });
  mcpEl("mcpConfigure")?.addEventListener("click",async()=>{
    if(mcpRuntime.configuring||mcpRemoteBrowser())return;
    const client=mcpSelectedClient(),clientName=client==="codex"?"Codex":client==="claude"?"Claude Code":"Other";
    mcpRuntime.configuring=true;mcpRuntime.configureResult=null;mcpRenderSettings();mcpEl("mcpConfigureStatus")?.scrollIntoView?.({block:"nearest"});
    try{
      const result=await mcpApi("configure",{client});
      if(result.configured===true)mcpRememberSetup();
      mcpRuntime.configureResult={client:clientName,kind:result.configured===true?"saved":result.existing?"existing":"uncertain"};
    }catch(error){
      const kind=error.existing?"existing":!error.status?"uncertain":"failed";
      mcpRuntime.configureResult={client:clientName,kind,detail:kind==="failed"?String(error.message):""};
    }finally{mcpRuntime.configuring=false;mcpRenderSettings();if(mcpEl("settingsPageMcp")?.hidden===false)mcpEl("mcpConfigureStatus")?.scrollIntoView?.({block:"nearest"});}
  });
  addEventListener("visibilitychange",()=>{if(!document.hidden&&mcpRuntime.socket){mcpRuntime.lastPong=Date.now();clearTimeout(mcpRuntime.heartbeatTimer);mcpHeartbeat(mcpRuntime.socket);}});
  addEventListener("offline",()=>{if(mcpRuntime.socket)mcpDisconnect(true);});
  addEventListener("pagehide",()=>mcpDisconnect());
