  // External MCP sessions share Canvas primitives, but never an Agent conversation.
  var mcpRuntime = { socket:null, generation:0, sessions:new Map(), controllers:new Map(), queue:Promise.resolve(), queued:0, status:null, loading:null, loadError:null, configuring:false, configureResult:null, feedbackSequence:0, feedback:[], ready:false, connectionLost:false, heartbeatTimer:0, heartbeatSupported:false, lastPong:0, activeMutation:null, glowTimer:0, glowing:false, pendingView:new Map(), layoutTimer:0, layoutSince:0, viewPaused:false };
  const mcpCopy = {
    nav:["MCP service","MCP 服务"], heading:["Work alongside your AI","与外部 AI 一起工作"],
    canvasNotice:["MCP connected · AI can update this canvas","MCP 已连接 · AI 可更新此画布"],
    canvasWaiting:["MCP open · Waiting for AI","MCP 已开放 · 等待 AI"],
    canvasLost:["MCP connection lost","MCP 连接已断开"],
    canvasApplying:["is updating the canvas…","正在更新画布…"],
    canvasSessions:["sessions","个会话"],
    canvasSession:["session","个会话"],
    newContent:["Show new content","查看新内容"],
    lastUpdate:["Last update","最近更新"],
    canvasNoticeHelp:["Open MCP settings to manage or turn off access to this canvas.","打开 MCP 设置，管理或关闭对此画布的访问。"],
    description:["Bring external AI sessions, progress and interactive previews onto this canvas.","把外部 AI 的会话、工作进度和交互预览带到这张画布。"],
    enable:["Allow external AI on this canvas","允许外部 AI 连接此画布"],
    accessHelp:["While connected, external AI can update its session objects and read new text, strokes and images you commit to this canvas after its session starts. Previews and visual feedback are captured on request.","连接期间，外部 AI 可以更新自己的会话对象，并读取会话开始后你在此画布提交的文字、笔画和图片。预览和视觉反馈仅按需截图。"],
    setup:["Connect an AI client","连接 AI 客户端"],refresh:["Check connection","检查连接"],client:["AI client","AI 客户端"],
    configure:["Configure automatically","自动配置"],copyConfig:["Copy configuration","复制配置"],copyInstructions:["Copy AI setup instructions","复制 AI 配置指引"],
    setupHelp:["Configure once. PenEcho finds its current port automatically. Reload the AI client after configuration.","只需配置一次，PenEcho 会自动发现当前端口。配置后请重新加载 AI 客户端。"],
    manual:["Manual configuration","手动配置"],sessions:["Sessions on this canvas","此画布上的会话"],
    copySkill:["Copy workflow skill","复制工作流技能"],copyGuide:["Copy setup guide","复制设置文档"],
    empty:["Connect your AI, then ask it to show its work in PenEcho. Each session gets its own work area.","连接 AI 后，让它在 PenEcho 展示工作。每个会话都有自己的工作区域。"],
    how:["How to use it","如何使用"],
    howHelp:["Ask your AI to publish a short plan and meaningful milestones. Use lightweight drawings for text and diagrams, function plots for curves, and Widgets for interactive UI. Request a screenshot when checking a design. Progress updates do not call another model or take screenshots.","让 AI 发布简短计划和重要进展。文字和关系图使用轻量绘图，曲线使用函数图，交互 UI 使用 Widget。检查设计时再获取截图。进度更新不调用额外模型，也不生成截图。"],
    thoughtHelp:["Shows the AI’s shared plans, decisions and results. Session updates are supplied by the external AI client.","展示 AI 分享的计划、决策和结果。会话更新由外部 AI 客户端主动提供。"],
    connected:["Connected · this canvas is discoverable","已连接 · 外部 AI 可发现此画布"], disconnected:["Disconnected · external access is off","未连接 · 外部访问已关闭"],connecting:["Connecting…","正在连接…"],
    localOnly:["Open this canvas on the local PenEcho host to enable MCP. Cloud MCP routing is not available yet.","请在本机 PenEcho 中打开画布以启用 MCP。当前版本尚不支持 Cloud MCP 路由。"],
    copied:["Copied","已复制"],configured:["Configuration saved. Reload the AI client, then check that PenEcho tools are available.","配置已保存。请重新加载 AI 客户端，并检查是否出现 PenEcho 工具。"],
    loadingConfig:["Loading connection configuration…","正在加载连接配置…"],
    configuring:["Configuring…","正在配置…"],
    configurePending:["Saving the MCP configuration. This may take up to 20 seconds.","正在保存 MCP 配置，可能需要约 20 秒。"],
    configureSaved:["Configuration saved","配置已保存"],
    configureExisting:["Existing configuration found · not verified","已发现已有配置 · 尚未验证"],
    configureExistingHelp:["No changes were made. Reload this AI client and check for PenEcho tools. If they are unavailable, compare its existing entry with Manual configuration below.","本次未修改配置。请重新加载此 AI 客户端，检查是否出现 PenEcho 工具；若未出现，请对照下方“手动配置”检查已有条目。"],
    configureFailed:["Automatic configuration failed","自动配置失败"],
    configureFailedHelp:["Try again, or use Copy AI setup instructions to finish setup in your client.","请重试，或使用“复制 AI 配置指引”在客户端完成设置。"],
    configureUncertain:["Configuration result not confirmed","配置结果尚未确认"],
    configureUncertainHelp:["The request did not finish. Check the AI client's PenEcho entry before retrying; it may already have been saved.","请求未完成。重试前请检查 AI 客户端中的 PenEcho 条目，配置可能已经保存。"],
    loadFailed:["Could not load the connection configuration. Select Check connection to retry.","未能加载连接配置。请点击“检查连接”重试。"],
    serviceOutdated:["This running PenEcho service has no usable MCP configuration. Restart PenEcho to load the updated service, then check again.","当前运行的 PenEcho 服务未提供有效的 MCP 配置。请重启 PenEcho 以加载更新后的服务，然后重新检查。"],
    hostRequired:["Configure MCP on the computer running PenEcho. Other devices can view the canvas but cannot configure its local AI clients.","请在运行 PenEcho 的电脑上配置 MCP。其他设备可以查看画布，但不能配置这台电脑的 AI 客户端。"],
    accessDenied:["MCP access was refused. On the PenEcho computer, try its localhost address, or refresh and unlock this page before checking again.","MCP 访问被拒绝。请在 PenEcho 所在电脑尝试 localhost 地址，或刷新并解锁页面后重新检查。"],
    focus:["Show","定位"],working:["Working","进行中"],waiting:["Waiting","等待中"],done:["Done","已完成"],error:["Needs attention","需要处理"],
  };
  function mcpText(key) { return mcpCopy[key]?.[state.language === "zh" ? 1 : 0] || key; }
  function mcpEl(id) { return document.getElementById(id); }
  function mcpLocal() { return !["cloud","viewer"].includes(window.PENECHO_CONFIG?.runtime); }
  function mcpExecutionCurrent(execution) {
    return execution.socket === mcpRuntime.socket && execution.socket?.readyState === WebSocket.OPEN
      && execution.generation === mcpRuntime.generation && !execution.controller.signal.aborted;
  }
  function mcpDisconnect(lost=false) {
    if(!mcpRuntime)return;
    mcpRuntime.generation++;
    clearTimeout(mcpRuntime.layoutTimer);mcpRuntime.layoutTimer=0;mcpRuntime.layoutSince=0;mcpRuntime.pendingView.clear();mcpRuntime.viewPaused=false;
    clearTimeout(mcpRuntime.heartbeatTimer);clearTimeout(mcpRuntime.glowTimer);
    mcpRuntime.heartbeatTimer=0;mcpRuntime.glowTimer=0;mcpRuntime.ready=false;mcpRuntime.heartbeatSupported=false;mcpRuntime.connectionLost=lost;mcpRuntime.activeMutation=null;mcpRuntime.glowing=false;
    for (const controller of mcpRuntime.controllers.values()) controller.abort();
    mcpRuntime.controllers.clear();
    const socket=mcpRuntime.socket; mcpRuntime.socket=null; socket?.close();
    mcpRuntime.sessions.clear();
    mcpRuntime.feedback=[];
    mcpRenderSettings();
  }
  function mcpRenderCanvasStatus() {
    const connected=mcpRuntime.ready&&mcpRuntime.socket?.readyState===WebSocket.OPEN,
      sessions=[...mcpRuntime.sessions.values()].filter(session=>!session.closed),
      clients=[...new Set(sessions.map(session=>session.client||"AI"))],
      notice=mcpEl("mcpCanvasNotice"),ring=mcpEl("mcpCanvasRing"),button=mcpEl("mcpCanvasNoticeButton");
    if(notice)notice.hidden=!mcpLocal()||(!connected&&!mcpRuntime.connectionLost);
    if(ring){ring.hidden=!connected;ring.setAttribute("data-state",mcpRuntime.glowing?"updating":"open");}
    const newButton=mcpEl("mcpShowNewContent"),count=[...mcpRuntime.pendingView.values()].reduce((sum,ids)=>sum+ids.size,0);
    if(newButton){newButton.hidden=!connected||!count;newButton.textContent=`${mcpText("newContent")} · ${count}`;}
    let label=mcpText("canvasLost");
    if(connected)label=mcpRuntime.activeMutation?`${mcpRuntime.activeMutation} ${mcpText("canvasApplying")}`:sessions.length?`MCP · ${clients.slice(0,2).join(" / ")}${clients.length>2?" +":""} · ${sessions.length} ${mcpText(sessions.length===1?"canvasSession":"canvasSessions")}`:mcpText("canvasWaiting");
    if(button){if(button.textContent!==label)button.textContent=label;button.title=mcpText("canvasNoticeHelp");}
  }
  // PenEcho owns deterministic placement and camera batching; MCP clients provide only content.
  function mcpTaskBounds(session,ids=null) {
    let region=null;
    for(const id of ids||[session.boardObjectId,...[...session.artifacts.values()].flatMap(item=>item.objectIds||[item.objectId])]){
      const object=canvasAgentObject(id);if(object)region=unionDirtyBounds(region,canvasAgentBox(object));
    }
    return region;
  }
  function mcpPlanPlacement(width,height,session=null) {
    const reserved=[...mcpRuntime.sessions.values()].filter(item=>item!==session&&item.layout).map(item=>item.layout.zone);
    if(!session){
      const zone=canvasAgentPlacementBox(4608,2400,{mode:"auto",gap:96},reserved);
      if(zone.crowded)throw Error("No clear space for another task. Free some Canvas space and try again.");
      return {placement:{mode:"absolute",x:zone.x,y:zone.y},layout:{zone:{x:zone.x,y:zone.y,w:4608,h:2400},x:zone.x,y:zone.y+height+48,rowHeight:0}};
    }
    const layout=session.layout||{zone:{...mcpTaskBounds(session)},x:0,y:0,rowHeight:0},zone=layout.zone,
      ink=visibleInkBounds({x:0,y:0,w:SIZE,h:SIZE}),occupied=[...canvasAgentAllObjects().map(item=>canvasAgentInternalRect(item.box)),...reserved,...(ink?[ink]:[])],
      right=Math.min(SIZE,zone.x+Math.max(2200,width));
    let x=layout.x,y=layout.y,rowHeight=layout.rowHeight;
    for(let attempt=0;attempt<256;attempt++){
      if(x+width>right){x=zone.x;y+=Math.max(rowHeight,1)+48;rowHeight=0;}
      if(y+height>SIZE)break;
      const candidate={x:x-24,y:y-24,w:width+48,h:height+48},hit=occupied.find(box=>intersection(candidate,box));
      if(hit){
        // Skip occupied space without moving user content or any earlier artifact.
        if(hit.x+hit.w+48+width<=right)x=hit.x+hit.w+48;
        else{x=zone.x;y=Math.max(y+48,hit.y+hit.h+48);rowHeight=0;}
        continue;
      }
      return {placement:{mode:"absolute",x,y},layout:{zone:{...zone,h:Math.max(zone.h,y+height-zone.y+48)},x:x+width+48,y,rowHeight:Math.max(rowHeight,height)}};
    }
    throw Error("This task has no clear space left. Move the task or free Canvas space before adding more previews.");
  }
  function mcpViewBusy() {
    return document.hidden||state.navigationLocked||state.drawing||state.panGesture||state.touchGesture||state.widgetGesture||state.imageGesture||state.selectionGesture||state.animationGesture||state.textEditors?.size||state.pointers?.size||document.activeElement?.tagName==="IFRAME"||mcpEl("settingsLayer")?.hidden===false;
  }
  function mcpPauseView() {
    if(!mcpRuntime.socket)return;
    mcpRuntime.viewPaused=true;clearTimeout(mcpRuntime.layoutTimer);mcpRuntime.layoutTimer=0;mcpRenderCanvasStatus();
  }
  function mcpQueueView(session,widget) {
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
    const groups=[...mcpRuntime.pendingView].filter(([id])=>mcpRuntime.sessions.has(id));
    if(!groups.length){mcpRuntime.pendingView.clear();mcpRenderCanvasStatus();return;}
    let region=null;
    for(const [id,ids] of groups)region=unionDirtyBounds(region,mcpTaskBounds(mcpRuntime.sessions.get(id),ids));
    let shown=groups;
    if(region&&canvasAgentFramePlan(region,64).scale<.4){
      shown=[groups[0]];region=mcpTaskBounds(mcpRuntime.sessions.get(shown[0][0]),shown[0][1]);
    }
    if(!region){for(const [id] of shown)mcpRuntime.pendingView.delete(id);mcpRenderCanvasStatus();return;}
    if(!explicit&&canvasAgentFramePlan(region,64).scale<.3){mcpRuntime.viewPaused=true;mcpRenderCanvasStatus();return;}
    canvasAgentFrameRegion(region,64);
    for(const [id] of shown)mcpRuntime.pendingView.delete(id);
    mcpRuntime.layoutSince=0;mcpRuntime.viewPaused=false;mcpRenderCanvasStatus();
  }

  function mcpHeartbeat(socket) {
    if(socket!==mcpRuntime.socket)return;
    if(!document.hidden&&(!mcpRuntime.ready||mcpRuntime.heartbeatSupported)&&Date.now()-mcpRuntime.lastPong>45000){mcpDisconnect(true);return;}
    if(socket.readyState===WebSocket.OPEN&&mcpRuntime.ready&&mcpRuntime.heartbeatSupported){try{socket.send(JSON.stringify({type:"ping"}));}catch{mcpDisconnect(true);return;}}
    mcpRuntime.heartbeatTimer=setTimeout(()=>mcpHeartbeat(socket),15000);
  }
  function mcpBeginMutation(client) {
    clearTimeout(mcpRuntime.glowTimer);mcpRuntime.activeMutation=client||"AI";mcpRuntime.glowing=true;mcpRenderCanvasStatus();
  }
  function mcpEndMutation() {
    mcpRuntime.activeMutation=null;mcpRenderCanvasStatus();
    mcpRuntime.glowTimer=setTimeout(()=>{mcpRuntime.glowing=false;mcpRuntime.glowTimer=0;mcpRenderCanvasStatus();},650);
  }
  function mcpRenderSettings() {
    if(!mcpRuntime)return;
    document.querySelectorAll("[data-mcp-label]").forEach(node=>{node.textContent=mcpText(node.dataset.mcpLabel);});
    const connected=mcpRuntime.ready&&mcpRuntime.socket?.readyState===WebSocket.OPEN, connecting=!!mcpRuntime.socket&&!connected;
    mcpRenderCanvasStatus();
    if(mcpEl("mcpEnabled")){mcpEl("mcpEnabled").setAttribute("aria-checked",String(connected||connecting));mcpEl("mcpEnabled").classList.toggle("on",connected||connecting);mcpEl("mcpEnabled").disabled=!mcpLocal();}
    if(mcpEl("mcpConnectionStatus"))mcpEl("mcpConnectionStatus").textContent=mcpText(!mcpLocal()?"localOnly":connected?"connected":connecting?"connecting":"disconnected");
    const config=mcpRuntime.status?.config;
    const configStatus=mcpEl("mcpConfigStatus");
    if(configStatus){configStatus.hidden=!mcpRuntime.loading&&!mcpRuntime.loadError;configStatus.textContent=mcpRuntime.loading?mcpText("loadingConfig"):mcpRuntime.loadError?mcpConfigurationErrorText(mcpRuntime.loadError):"";}
    if(mcpEl("mcpConfig"))mcpEl("mcpConfig").textContent=config?JSON.stringify({mcpServers:{penecho:config}},null,2):"";
    for(const id of ["mcpCopyConfig","mcpCopyInstructions","mcpConfigure"])if(mcpEl(id))mcpEl(id).disabled=!config;
    if(mcpEl("mcpConfigure")&&mcpRuntime.configuring)mcpEl("mcpConfigure").disabled=true;
    if(mcpEl("mcpConfigure")){mcpEl("mcpConfigure").textContent=mcpText(mcpRuntime.configuring?"configuring":"configure");mcpEl("mcpConfigure").setAttribute("aria-busy",String(mcpRuntime.configuring));}
    if(mcpEl("mcpClient"))mcpEl("mcpClient").disabled=mcpRuntime.configuring;
    const configureNotice=mcpEl("mcpConfigureStatus"),outcome=mcpRuntime.configureResult;
    if(configureNotice){
      configureNotice.hidden=!mcpRuntime.configuring&&!outcome;
      configureNotice.classList.toggle("success",!mcpRuntime.configuring&&outcome?.kind==="saved");
      configureNotice.classList.toggle("error",!mcpRuntime.configuring&&outcome?.kind==="failed");
      configureNotice.textContent=mcpRuntime.configuring?mcpText("configurePending"):outcome?`${outcome.client} · ${mcpText({saved:"configureSaved",existing:"configureExisting",failed:"configureFailed",uncertain:"configureUncertain"}[outcome.kind])}\n${mcpText({saved:"configured",existing:"configureExistingHelp",failed:"configureFailedHelp",uncertain:"configureUncertainHelp"}[outcome.kind])}${outcome.detail?`\n${outcome.detail}`:""}`:"";
    }
    if(mcpEl("mcpConfigure"))mcpEl("mcpConfigure").hidden=mcpEl("mcpClient")?.value==="other";
    if(mcpEl("settingsPageMcp")?.hidden!==false)return;
    const list=mcpEl("mcpSessionList"); if(!list)return;
    list.replaceChildren();
    mcpEl("mcpEmpty").hidden=mcpRuntime.sessions.size>0;
    for(const session of mcpRuntime.sessions.values()){
      const row=document.createElement("div"),copy=document.createElement("div"),title=document.createElement("strong"),status=document.createElement("small"),button=document.createElement("button");
      copy.className="mcp-session-copy";title.textContent=session.title;status.textContent=[session.client,mcpText(session.status),session.updatedAt?`${mcpText("lastUpdate")} ${new Date(session.updatedAt).toLocaleTimeString(state.language==="zh"?"zh-CN":"en-US",{hour:"2-digit",minute:"2-digit",second:"2-digit"})}`:""].filter(Boolean).join(" · ");
      copy.append(title,status);button.type="button";button.textContent=mcpText("focus");peButton(button,"secondary","compact");
      button.addEventListener("click",()=>{const board=canvasAgentObject(session.boardObjectId);if(board){mcpPauseView();closeSettings();canvasAgentFrameRegion(mcpTaskBounds(session)||canvasAgentBox(board),64);mcpRuntime.pendingView.delete(session.sessionId);mcpRenderCanvasStatus();}});
      row.append(copy,button);list.append(row);
    }
  }
  function mcpConfigurationErrorText(error) {
    if(error.code==="local_host_required")return mcpText("hostRequired");
    if([404,405].includes(error.status)||error.code==="mcp_configuration_unavailable")return mcpText("serviceOutdated");
    if([401,403].includes(error.status))return mcpText("accessDenied");
    return mcpText("loadFailed");
  }
  async function mcpApi(path,body={}) {
    const response=await fetch(`/api/mcp/${path}`,{method:"POST",headers:authenticatedApiHeaders({"Content-Type":"application/json"}),credentials:"same-origin",cache:"no-store",body:JSON.stringify(body),signal:AbortSignal.timeout(path==="configure"?20000:5000)});
    const result=await response.json().catch(()=>null);
    if(!response.ok||!result||typeof result!=="object")throw Object.assign(Error(typeof result?.error==="string"?result.error:result?.error?.message||"MCP request failed."),{status:response.status,code:result?.error?.code,existing:result?.existing===true});
    return result;
  }
  async function mcpRefreshSettings() {
    if(!mcpLocal()||mcpRuntime.loading){mcpRenderSettings();return mcpRuntime.loading;}
    mcpRuntime.loadError=null;
    mcpRuntime.loading=(async()=>{
      try{
        const status=await mcpApi("status"),config=status.config;
        if(!config||typeof config.command!=="string"||!config.command.trim()||!Array.isArray(config.args)||config.args.some(arg=>typeof arg!=="string"))throw Object.assign(Error("MCP configuration is unavailable."),{code:"mcp_configuration_unavailable"});
        mcpRuntime.status=status;
      }catch(error){mcpRuntime.status=null;mcpRuntime.loadError=error;}
      finally{mcpRuntime.loading=null;mcpRenderSettings();}
    })();
    mcpRenderSettings();return mcpRuntime.loading;
  }
  function mcpInstructions() {
    return `Configure PenEcho MCP for the AI client I am using. Read its installed MCP help or official documentation. Preserve unrelated servers and settings; do not invent client commands. Use this exact stdio launch configuration (absolute paths and env matter):\n${JSON.stringify({mcpServers:{penecho:mcpRuntime.status?.config}},null,2)}\nNo server URL, port, API key or npm download is needed. This bridge discovers local PenEcho instances. Reload the client and verify penecho_list_canvases appears. If no canvas is listed, ask me to open PenEcho Settings → MCP service and allow this canvas. Select the intended instanceId and canvasId explicitly, then penecho_start_session with a descriptive title, client name and a unique sessionKey for this conversation. Each conversation must use its own sessionId.\nWith an already selected live connection, proactively show useful UI previews, a small set of alternatives for user choice, or a diagram when it clarifies the task. Avoid decorative output for routine edits. Update stable artifacts and keep ordinary presentation capture:false: generating a screenshot does not call a model, but a model reading that image may incur image-input tokens. While doing my real work, publish a concise public plan and meaningful milestones with penecho_update_session (batch steps/events). Never publish private chain of thought, secrets or full transcripts. Do not update per token or every tool call. Keep the primary task moving if visualization is offline. Use penecho_draw for lightweight native text, shapes, connectors or paths, and penecho_plot for function expressions. Nodes can omit local positions; PenEcho handles placement. Draw items are a complete artifact replacement, so retain all desired element IDs. Shapes and paths are native image objects, not editable vector handles or eraser-layer strokes. Both tools support capture:true for bounded visual verification. Use penecho_present_widget with a stable artifactId for interactive HTML UI previews. When presenting code that needs immediate visual validation, use penecho_present_widget with capture:true in one call. Otherwise use penecho_capture_widget only when visual validation is needed; read the image and timing/diagnostics. It is an embedded Widget preview, not full browser navigation or end-to-end automation. Before revising a design, call penecho_read_feedback for your session. Keep an independent after cursor, page with nextCursor while hasMore, and advance only after processing. Feedback defaults to one compressed screenshot with nearby design context, including text-only feedback. Read the image; use capture:false only for a lightweight availability check. Never discard unread feedback by replacing your cursor with a newer presentation feedbackCursor. Reads do not clear Canvas dirty state or other sessions. Handle truncated history explicitly. Only committed user input after the session board was applied is available; no automatic wake-up or tight polling. Finish with status done or error and a short verified result. Do not claim a tool succeeded without its result.\n${mcpRuntime.status?.instructions||""}`;
  }
  function mcpConnect() {
    if(!mcpLocal())return;
    mcpDisconnect();
    const socket=new WebSocket(`${location.protocol==="https:"?"wss:":"ws:"}//${location.host}/api/mcp/canvas`),generation=mcpRuntime.generation;
    mcpRuntime.socket=socket;mcpRuntime.lastPong=Date.now();mcpHeartbeat(socket);
    socket.addEventListener("open",()=>{if(socket!==mcpRuntime.socket)return;socket.send(JSON.stringify({type:"hello",canvasId:canvasClientId(),title:state.currentSnapshotName||"PenEcho Canvas"}));mcpRenderSettings();});
    socket.addEventListener("message",event=>{
      if(socket!==mcpRuntime.socket)return;let message;try{message=JSON.parse(event.data);}catch{return;}
      if(message.type==="ready"){mcpRuntime.ready=true;mcpRuntime.heartbeatSupported=message.heartbeat===true;mcpRuntime.lastPong=Date.now();mcpRenderSettings();return;}
      if(message.type==="pong"){mcpRuntime.lastPong=Date.now();return;}
      if(message.type==="cancel"){mcpRuntime.controllers.get(message.requestId)?.abort();return;}
      if(message.type!=="call")return;
      if(mcpRuntime.queued>=32){socket.send(JSON.stringify({type:"result",requestId:message.requestId,ok:false,error:{code:"CANVAS_BUSY",message:"Canvas update queue is full."}}));return;}
      const controller=new AbortController();mcpRuntime.controllers.set(message.requestId,controller);mcpRuntime.queued++;
      const execution={kind:"mcp",socket,generation,controller,preserveView:true};
      mcpRuntime.queue=mcpRuntime.queue.catch(()=>{}).then(async()=>{
        const started=performance.now(),mutation=["mcp_start_session","mcp_update_session","mcp_present_widget","mcp_draw","mcp_plot","mcp_close_session"].includes(message.name);
        try{
          canvasAgentAssertToolExecution(execution);
          if(mutation)mcpBeginMutation(message.arguments?.client||mcpRuntime.sessions.get(message.arguments?.sessionId)?.client);
          const result=await mcpExecute(message.name,message.arguments||{},execution);
          canvasAgentAssertToolExecution(execution);
          if(mutation){const session=mcpRuntime.sessions.get(message.arguments?.sessionId);if(session)session.updatedAt=Date.now();}
          socket.send(JSON.stringify({type:"result",requestId:message.requestId,ok:true,result:{...result,browserElapsedMs:Math.round(performance.now()-started)}}));
        }catch(error){if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:"result",requestId:message.requestId,ok:false,error:{code:error.code||"CANVAS_TOOL_FAILED",message:String(error.message||error)}}));}
        finally{mcpRuntime.queued--;mcpRuntime.controllers.delete(message.requestId);if(mutation&&socket===mcpRuntime.socket){mcpEndMutation();mcpRenderSettings();}}
      });
    });
    socket.addEventListener("close",()=>{if(socket===mcpRuntime.socket)mcpDisconnect(true);});
    socket.addEventListener("error",()=>{if(socket===mcpRuntime.socket)mcpDisconnect(true);});
    mcpRenderSettings();
  }
  function mcpEscape(text) { return String(text??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
  // Record committed user input only. Never scan pixels or consume Canvas dirty state here.
  function mcpRecordFeedback(kind,bounds,item=null) {
    if(!mcpRuntime||mcpRuntime.socket?.readyState!==WebSocket.OPEN||!bounds)return;
    if(![bounds.x,bounds.y,bounds.w,bounds.h].every(Number.isFinite))return;
    const entry={cursor:++mcpRuntime.feedbackSequence,kind,bounds:{x:bounds.x,y:bounds.y,w:Math.max(1,bounds.w),h:Math.max(1,bounds.h)},createdAt:Date.now()};
    if(item?.id)entry.objectId=String(item.id);
    if(kind==="text"){entry.text=String(item?.text||"").slice(0,4000);entry.textTruncated=String(item?.text||"").length>4000;}
    mcpRuntime.feedback.push(entry);
    if(mcpRuntime.feedback.length>200)mcpRuntime.feedback.splice(0,mcpRuntime.feedback.length-200);
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
  async function mcpExecute(name,args,execution) {
    if(name==="mcp_start_session"){
      if(mcpRuntime.sessions.has(args.sessionId))return {sessionId:args.sessionId,boardObjectId:mcpRuntime.sessions.get(args.sessionId).boardObjectId,feedbackCursor:mcpRuntime.sessions.get(args.sessionId).feedbackStart};
      const session={sessionId:args.sessionId,title:args.title,client:args.client||"",status:"working",summary:"",steps:[],events:[],artifacts:new Map(),feedbackStart:mcpRuntime.feedbackSequence};
      const plan=mcpPlanPlacement(840,600);
      const board=await mcpCreateWidget({title:session.title,html:mcpBoardHtml(session),width:840,height:600,placement:plan.placement},{...execution,preserveView:true});
      session.layout=plan.layout;
      session.feedbackStart=mcpRuntime.feedbackSequence;session.boardObjectId=board.id;mcpRuntime.sessions.set(args.sessionId,session);mcpQueueView(session,board);mcpRenderSettings();
      return {sessionId:args.sessionId,boardObjectId:board.id,revision:state.userRevision,feedbackCursor:session.feedbackStart};
    }
    const session=mcpRuntime.sessions.get(args.sessionId);if(!session)throw Error("MCP session is no longer connected to this canvas. Start a new session.");
    if(name==="mcp_read_feedback")return mcpReadFeedback(session,args,execution);
    const board=canvasAgentObject(session.boardObjectId)?.item;if(!board)throw Error("The session board was removed. Start a new session.");
    if(name==="mcp_update_session"){
      for(const key of ["title","status","summary","steps"])if(args[key]!==undefined)session[key]=args[key];
      if(args.events){const events=new Map(session.events.map(event=>[event.id,event]));for(const event of args.events)events.set(event.id,event);session.events=[...events.values()].slice(-40);}
      board.html=mcpBoardHtml(session);board.title=session.title;board.mcpProgress=mcpProgressData(session);board.contentVersion=(board.contentVersion||0)+1;
      board.shell?.setAttribute("aria-label",`${session.title}. ${t("widgetRefineHint")}`);if(board.frame)board.frame.title=session.title;
      board.snapshotVersion=-1;state.userRevision++;syncMcpWidgetProgress(board);
      if(["done","error"].includes(session.status))save();
      mcpRenderSettings();return {applied:true,visible:board.renderActive!==false,revision:state.userRevision};
    }
    if(name==="mcp_draw"||name==="mcp_plot")return mcpPresentPrimitives(session,args,name==="mcp_draw"?"drawing":"plot",execution);
    if(name==="mcp_present_widget"){
      if(session.artifacts.get(args.artifactId)?.kind)throw Error("This artifact is a drawing or plot. Use its original tool to update it.");
      let artifact=session.artifacts.get(args.artifactId),widget=artifact&&canvasAgentObject(artifact.objectId)?.item;
      if(artifact&&!widget)throw Error("This preview was removed. Use a new artifactId to create another.");
      if(widget){
        const context=widgetEditContext(widget,"agent"),expectedHash=await canvasAgentHash(context);
        const command={...context,tool:"html_widget",pluginId:"general",html:args.html,title:args.title,x:widget.x,y:widget.y,w:widget.w,h:widget.h};
        await canvasAgentReplaceWidget({baseRevision:state.userRevision,objectId:widget.id,expectedHash,command},execution);
        // Resize the document viewport along with its footprint, preserving typography scale.
        for(const dimension of ["width","height"]){
          const contentKey=dimension==="width"?"contentW":"contentH",sizeKey=dimension==="width"?"w":"h";
          if(args[dimension]&&args[dimension]!==widget[contentKey])await canvasAgentEdit({baseRevision:state.userRevision,operations:[{type:"resize_widget",objectId:widget.id,dimension,value:args[dimension]*widget[sizeKey]/widget[contentKey]}]},execution);
        }
      }else{
        const plan=mcpPlanPlacement(args.width||960,args.height||640,session);
        widget=await mcpCreateWidget({title:args.title,html:args.html,width:args.width||960,height:args.height||640,placement:plan.placement},{...execution,preserveView:true});
        session.layout=plan.layout;mcpQueueView(session,widget);
        artifact={objectId:widget.id,title:args.title};session.artifacts.set(args.artifactId,artifact);
      }
      artifact.title=args.title;
      return {artifactId:args.artifactId,objectId:widget.id,revision:state.userRevision,feedbackCursor:mcpRuntime.feedbackSequence,viewport:{width:widget.contentW,height:widget.contentH},runtimeDiagnostics:widget.runtimeDiagnostics||null};
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
      if(!object.item.frame?.contentWindow)mountWidget(object.item);
      if(!object.item.frame?.contentWindow)throw Error("Preview could not be mounted. Check that the General Widget plugin is available.");
      const previousActive=object.item.renderActive;
      try {
      await mcpWaitForWidgetLoad(object.item,execution);
      const quality=args.quality||"basic",policy=quality==="detail"?CANVAS_AGENT_DETAIL_CAPTURE_POLICY:CANVAS_AGENT_LAYOUT_CAPTURE_POLICY,
        started=performance.now(),snapshot=await requestWidgetSnapshot(object.item,WIDGET_SNAPSHOT_TIMEOUT_MS,true,execution.controller.signal,quality==="detail");
      canvasAgentAssertToolExecution(execution);
      const rasterMs=Math.round(performance.now()-started),scale=Math.min(1,policy.maxLongEdge/Math.max(snapshot.width,snapshot.height),Math.sqrt(policy.maxPixels/(snapshot.width*snapshot.height))),canvas=document.createElement("canvas");
      canvas.width=Math.max(1,Math.floor(snapshot.width*scale));canvas.height=Math.max(1,Math.floor(snapshot.height*scale));canvas.getContext("2d").drawImage(snapshot,0,0,canvas.width,canvas.height);
      const encoded=await canvasAgentCompressedCanvas(canvas,policy),dataUrl=await canvasAgentReadDataUrl(encoded.blob);
      canvasAgentAssertToolExecution(execution);
      const result={dataUrl,mediaType:encoded.blob.type,width:encoded.canvas.width,height:encoded.canvas.height,encodedBytes:encoded.blob.size,quality,
        artifactId:args.artifactId,objectId:artifact.objectId,revision:state.userRevision,viewport:{width:object.item.contentW,height:object.item.contentH},rasterMs,
        runtimeDiagnostics:object.item.runtimeDiagnostics||null};
      canvas.width=canvas.height=1;if(encoded.canvas!==canvas)encoded.canvas.width=encoded.canvas.height=1;
      return result;
      } finally { if(previousActive===false){object.item.renderActive=false;object.item.shell?.classList.add("widget-offscreen");sendWidgetHostState(object.item,undefined,undefined,true);} }
    }
    if(name==="mcp_inspect_session")return {sessionId:session.sessionId,boardObjectId:board.id,...mcpProgressData(session),artifacts:[...session.artifacts].map(([artifactId,value])=>{const object=canvasAgentObject(value.objectId);return {artifactId,title:value.title,kind:value.kind||"widget",objectId:value.objectId,...(value.objectIds?{objectIds:value.objectIds,elements:(value.elements||[]).map(([id,entry])=>{const child=canvasAgentObject(entry.objectId);return {id,objectId:entry.objectId,kind:entry.kind,...(child?{bounds:canvasAgentBox(child)}:{removed:true})};})}:{}),...(object?{bounds:value.objectIds?mcpTaskBounds(session,value.objectIds):canvasAgentBox(object)}:{removed:true})};}),revision:state.userRevision};
    if(name==="mcp_close_session"){session.status="done";await mcpExecute("mcp_update_session",{sessionId:args.sessionId,status:"done"},execution);session.closed=true;mcpRuntime.pendingView.delete(session.sessionId);mcpRenderSettings();return {closed:true,retainedOnCanvas:true};}
    throw Error(`Unsupported MCP Canvas operation: ${name}`);
  }
  mcpEl("mcpEnabled")?.addEventListener("click",event=>event.currentTarget.getAttribute("aria-checked")==="true"?mcpDisconnect():mcpConnect());
  mcpEl("mcpCanvasNoticeButton")?.addEventListener("pointerdown",event=>event.stopPropagation());
  mcpEl("mcpCanvasNoticeButton")?.addEventListener("click",event=>{event.stopPropagation();openSettings();selectSettingsPage("mcp");});
  mcpEl("mcpShowNewContent")?.addEventListener("pointerdown",event=>event.stopPropagation());
  mcpEl("mcpShowNewContent")?.addEventListener("click",event=>{event.stopPropagation();mcpFlushView(true);});
  mcpEl("viewport")?.addEventListener("pointerdown",mcpPauseView,{capture:true,passive:true});
  mcpEl("viewport")?.addEventListener("wheel",mcpPauseView,{passive:true});
  mcpEl("viewport")?.addEventListener("keydown",event=>{if([" ","ArrowUp","ArrowDown","ArrowLeft","ArrowRight","+","-","="].includes(event.key))mcpPauseView();});
  mcpEl("mcpRefresh")?.addEventListener("click",()=>void mcpRefreshSettings());
  mcpEl("mcpClient")?.addEventListener("change",()=>{mcpRuntime.configureResult=null;mcpRenderSettings();});
  for(const [id,instructions] of [["mcpCopyConfig",false],["mcpCopyInstructions",true]])mcpEl(id)?.addEventListener("click",async()=>{
    const copied=await writeClipboardText(instructions?mcpInstructions():JSON.stringify({mcpServers:{penecho:mcpRuntime.status?.config}},null,2));mcpEl("mcpSetupStatus").textContent=copied?mcpText("copied"):t("copyFailed");
  });
  for(const [id,route] of [["mcpCopySkill","skill"],["mcpCopyGuide","guide"]])mcpEl(id)?.addEventListener("click",async()=>{
    try{const result=await mcpApi(route),copied=await writeClipboardText(result.text);mcpEl("mcpSetupStatus").textContent=copied?mcpText("copied"):t("copyFailed");}
    catch(error){mcpEl("mcpSetupStatus").textContent=String(error.message);}
  });
  mcpEl("mcpConfigure")?.addEventListener("click",async()=>{
    if(mcpRuntime.configuring)return;
    const client=mcpEl("mcpClient").value,clientName=client==="codex"?"Codex":"Claude Code";
    mcpRuntime.configuring=true;mcpRuntime.configureResult=null;mcpRenderSettings();mcpEl("mcpConfigureStatus")?.scrollIntoView?.({block:"nearest"});
    try{
      const result=await mcpApi("configure",{client});
      mcpRuntime.configureResult={client:clientName,kind:result.configured===true?"saved":result.existing?"existing":"uncertain"};
    }catch(error){
      const kind=error.existing?"existing":!error.status?"uncertain":"failed";
      mcpRuntime.configureResult={client:clientName,kind,detail:kind==="failed"?String(error.message):""};
    }finally{mcpRuntime.configuring=false;mcpRenderSettings();if(mcpEl("settingsPageMcp")?.hidden===false)mcpEl("mcpConfigureStatus")?.scrollIntoView?.({block:"nearest"});}
  });
  addEventListener("visibilitychange",()=>{if(!document.hidden&&mcpRuntime.socket){mcpRuntime.lastPong=Date.now();clearTimeout(mcpRuntime.heartbeatTimer);mcpHeartbeat(mcpRuntime.socket);}});
  addEventListener("pagehide",()=>mcpDisconnect());
