"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { TOOLS, validateToolArguments } = require("../src/server/mcp/schema.js");

const baseDraw = {
  sessionId:"session-a",
  artifactId:"diagram-a",
  title:"Native diagram",
  items:[
    {id:"source",type:"text",text:"First line\nSecond line",x:10,y:20,width:180,height:80,color:"#A0B1C2",fontSize:14},
    {id:"target",type:"ellipse",text:"Target",fontSize:18,fill:"transparent",strokeWidth:2},
    {id:"edge",type:"arrow",from:"source",to:"target",color:"#abc"},
    {id:"path",type:"path",points:[{x:0,y:0},{x:100,y:120}],fill:"#12345678"},
  ],
};

test("native drawing schema accepts bounded nodes, referenced edges, paths, and optional capture", () => {
  assert.deepEqual(validateToolArguments("penecho_draw", {...baseDraw,capture:true}), {...baseDraw,capture:true});
  const tool = TOOLS.find(entry => entry.name === "penecho_draw");
  assert.equal(tool.inputSchema.properties.items.maxItems, 24);
  assert.equal(tool.inputSchema.properties.capture.default, false);
  assert.equal(tool.inputSchema.properties.items.items.allOf[0].then.properties.width.minimum, 80);
  assert.match(tool.description, /not an iframe Widget/);
});

test("native drawing schema rejects ambiguous geometry, unsafe text, references, and aggregate size", () => {
  const invalidItems = [
    [{id:"node",type:"rect",x:10}],
    [{id:"node",type:"text"}],
    [{id:"node",type:"text",text:"bad\ttext"}],
    [{id:"node",type:"rect",bogus:true}],
    [{id:"path",type:"path"}],
    [{id:"line",type:"line",points:[{x:0,y:0},{x:1,y:1},{x:2,y:2}]}],
    [{id:"line",type:"line",from:"node"}],
    [{id:"node",type:"rect"},{id:"line",type:"arrow",from:"node",to:"node"}],
    [{id:"path",type:"path",points:[{x:0,y:0},{x:2401,y:1}]}],
    [{id:"node",type:"ellipse",fill:"red"}],
    [{id:"node",type:"rect",width:7}],
    [{id:"node",type:"ellipse",text:"Label",fontSize:11}],
  ];
  for (const items of invalidItems) {
    assert.throws(() => validateToolArguments("penecho_draw", {...baseDraw,items}), error => error.code === "invalid_arguments");
  }
  assert.throws(() => validateToolArguments("penecho_draw", {...baseDraw,items:[{id:"same",type:"rect"},{id:"same",type:"ellipse"}]}), /Duplicate item id/);
  assert.throws(() => validateToolArguments("penecho_draw", {...baseDraw,items:[{id:"path",type:"path",points:Array.from({length:257}, (_, index) => ({x:index,y:index}))}]}), /points is invalid/);
  assert.throws(() => validateToolArguments("penecho_draw", {
    ...baseDraw,
    items:Array.from({length:9}, (_, itemIndex) => ({id:`path-${itemIndex}`,type:"path",points:Array.from({length:256}, (_, index) => ({x:index,y:itemIndex}))})),
  }), /more than 2048 points/);
  assert.throws(() => validateToolArguments("penecho_draw", {...baseDraw,items:Array.from({length:25}, (_, index) => ({id:`node-${index}`,type:"rect"}))}), /items is invalid/);
  assert.throws(() => validateToolArguments("penecho_draw", {...baseDraw,capture:"yes"}), /capture is invalid/);
});

test("native plot schema validates dimensions, domain pairs, color, and expression without evaluating it", () => {
  const input = {sessionId:"session-a",artifactId:"plot-a",title:"Plot",expression:"sin(x) + sqrt(abs(x))",width:640.4,height:360.2,xMin:-10,xMax:10,yMin:-5,yMax:5,color:"#ABCDEF",capture:true};
  assert.deepEqual(validateToolArguments("penecho_plot", input), {...input,width:640,height:360});
  const tool = TOOLS.find(entry => entry.name === "penecho_plot");
  assert.equal(tool.inputSchema.properties.capture.default, false);
  assert.match(tool.description, /without eval/);

  for (const patch of [
    {width:299},
    {height:1201},
    {xMin:0},
    {xMin:1,xMax:1},
    {xMin:0,xMax:0.0000009},
    {xMin:-1_000_001,xMax:1},
    {yMin:-1,yMax:1},
    {xMin:-1,xMax:1,yMin:2},
    {color:"rgb(0,0,0)"},
    {expression:""},
    {expression:"x\ny"},
    {capture:1},
  ]) {
    assert.throws(() => validateToolArguments("penecho_plot", {...input,xMin:undefined,xMax:undefined,yMin:undefined,yMax:undefined,...patch}), error => error.code === "invalid_arguments");
  }
});

test("presentation semantics normalize defaults, viewport presets, and legacy dimensions", () => {
  const widget = {sessionId:"session-a",artifactId:"widget-a",title:"Widget",html:"<main>Hi</main>"};
  assert.deepEqual(validateToolArguments("penecho_present_widget", widget), {...widget,width:480,height:360});
  assert.deepEqual(validateToolArguments("penecho_present_widget", {...widget,presentation:{intent:"compare",role:"alternative",size:"large",relativeTo:"source"}}), {
    ...widget,
    width:992,
    height:752,
    presentation:{intent:"compare",role:"alternative",size:"large",relativeTo:"source",relation:"beside",attention:"quiet"},
  });
  assert.deepEqual(validateToolArguments("penecho_present_widget", {...widget,width:700}), {...widget,width:700,height:360});
  assert.deepEqual(validateToolArguments("penecho_present_widget", {...widget,presentation:{size:"page"}}), {
    ...widget,
    width:1200,
    height:800,
    presentation:{intent:"deliver",role:"primary",size:"page",attention:"normal"},
  });
  const mobile = {...widget,width:390,height:844};
  assert.deepEqual(validateToolArguments("penecho_present_widget", mobile), mobile);
  assert.throws(() => validateToolArguments("penecho_present_widget", {...mobile,presentation:{size:"page"}}), /cannot be combined/);
  assert.deepEqual(validateToolArguments("penecho_plot", {sessionId:"s",artifactId:"p",title:"P",expression:"x",presentation:{intent:"review",size:"page"}}), {
    sessionId:"s",artifactId:"p",title:"P",expression:"x",width:1200,height:800,
    presentation:{intent:"review",role:"primary",size:"page",attention:"request"},
  });
  assert.deepEqual(validateToolArguments("penecho_draw", {...baseDraw,presentation:{role:"supporting",relativeTo:"widget-a"}}).presentation, {
    intent:"deliver",role:"supporting",relativeTo:"widget-a",relation:"below",attention:"quiet",
  });
  const presentationSchema = TOOLS.find(entry => entry.name === "penecho_present_widget").inputSchema.properties.presentation;
  assert.deepEqual(presentationSchema.properties.intent.enum, ["explain","deliver","compare","review","inspect"]);
  assert.match(presentationSchema.properties.size.description, /base 480×360/);
  assert.match(presentationSchema.properties.size.description, /page 1200×800 \(desktop UI\)/);
  assert.equal(TOOLS.find(entry => entry.name === "penecho_plot").inputSchema.properties.presentation.properties.size.description, presentationSchema.properties.size.description);
  assert.equal(presentationSchema.additionalProperties, false);
});

test("presentation semantics reject conflicting or unsupported placement and inspect requests", () => {
  const widget = {sessionId:"session-a",artifactId:"widget-a",title:"Widget",html:"<main>Hi</main>"};
  for (const presentation of [
    {intent:"unknown"},
    {size:"wide",unexpected:true},
    {relation:"beside"},
    {relativeTo:"x".repeat(129)},
  ]) assert.throws(() => validateToolArguments("penecho_present_widget", {...widget,presentation}), /presentation/);
  assert.throws(() => validateToolArguments("penecho_present_widget", {...widget,width:640,presentation:{size:"wide"}}), /cannot be combined/);
  assert.throws(() => validateToolArguments("penecho_draw", {...baseDraw,presentation:{size:"wide"}}), /not valid for drawings/);
  assert.throws(() => validateToolArguments("penecho_draw", {...baseDraw,presentation:{intent:"inspect"}}), /only for widgets/);
  assert.throws(() => validateToolArguments("penecho_present_widget", {...widget,presentation:{intent:"inspect"}}), /requires capture/);
  assert.throws(() => validateToolArguments("penecho_present_widget", {...widget,capture:true,presentation:{intent:"inspect",attention:"normal"}}), /quiet attention/);
  assert.throws(() => validateToolArguments("penecho_present_widget", {...widget,capture:true,presentation:{intent:"inspect",relativeTo:"source"}}), /cannot use/);
  assert.deepEqual(validateToolArguments("penecho_present_widget", {...widget,capture:true,presentation:{intent:"inspect"}}).presentation, {
    intent:"inspect",role:"primary",size:"base",attention:"quiet",
  });
});

test("persistent document, virtual file, edit, and inbox schemas are strict and bounded", () => {
  assert.deepEqual(validateToolArguments("penecho_open_canvas", {instanceId:"i",canvasId:"c",create:true,title:"New",requestId:"r"}), {instanceId:"i",canvasId:"c",requestId:"r",show:false,create:true,title:"New"});
  assert.deepEqual(validateToolArguments("penecho_open_canvas", {instanceId:"i",canvasId:"c",locator:{location:"cloud",id:"cloud-1"},requestId:"r",show:true}), {instanceId:"i",canvasId:"c",requestId:"r",show:true,locator:{location:"cloud",id:"cloud-1"}});
  assert.deepEqual(validateToolArguments("penecho_open_canvas", {instanceId:"i",canvasId:"c",documentId:"d",locator:{location:"device",id:"saved-1"},requestId:"r"}), {instanceId:"i",canvasId:"c",requestId:"r",show:false,documentId:"d",locator:{location:"device",id:"saved-1"}});
  assert.throws(() => validateToolArguments("penecho_open_canvas", {instanceId:"i",canvasId:"c",requestId:"r"}), /Provide create:true/);
  assert.throws(() => validateToolArguments("penecho_open_canvas", {instanceId:"i",canvasId:"c",create:true,documentId:"d",requestId:"r"}), /create cannot/);
  assert.deepEqual(validateToolArguments("penecho_start_session", {instanceId:"i",canvasId:"c",documentId:"d",title:"Work"}), {instanceId:"i",canvasId:"c",documentId:"d",title:"Work"});
  assert.deepEqual(validateToolArguments("penecho_list_files", {sessionId:"s"}), {sessionId:"s",path:"/",offset:0,limit:50});
  assert.deepEqual(validateToolArguments("penecho_read_file", {sessionId:"s",path:"notes/a.md",startLine:2,endLine:3}), {sessionId:"s",path:"/notes/a.md",startLine:2,endLine:3});
  for (const path of ["../secret","/a/../b","/a//b","a\\b","a\0b","/%2e%2e/secret","/a%2fb","/%5cserver"]) assert.throws(() => validateToolArguments("penecho_read_file", {sessionId:"s",path}), /path is invalid/);
  assert.throws(() => validateToolArguments("penecho_patch_file", {sessionId:"s",path:"/a",contentHash:"h",patch:"x".repeat(800_001),requestId:"r"}), /too large/);
  assert.deepEqual(validateToolArguments("penecho_edit_canvas", {sessionId:"s",requestId:"r",action:"move",objectId:"o",region:{x:-1,y:2,w:3,h:4},baseRevision:7}).action, "move");
  assert.deepEqual(validateToolArguments("penecho_edit_canvas", {sessionId:"s",requestId:"r",action:"replace_image",objectId:"o",source:"penecho-ref:objects/object-1/image",baseRevision:7}).source, "penecho-ref:objects/object-1/image");
  assert.throws(() => validateToolArguments("penecho_edit_canvas", {sessionId:"s",requestId:"r",action:"replace_image",objectId:"o",source:"https://example.com/a.png",baseRevision:7}), /authorized/);
  assert.throws(() => validateToolArguments("penecho_edit_canvas", {sessionId:"s",requestId:"r",action:"delete",objectId:"o"}), /baseRevision is required/);
  assert.throws(() => validateToolArguments("penecho_edit_canvas", {sessionId:"s",requestId:"r",action:"delete",objectId:"o",baseRevision:7,text:"extra"}), /not valid/);
  assert.deepEqual(validateToolArguments("penecho_capture_canvas", {sessionId:"s"}), {sessionId:"s",target:"viewport",quality:"basic"});
  assert.deepEqual(validateToolArguments("penecho_capture_canvas", {sessionId:"s",target:"object",objectId:"image-1",quality:"detail"}), {sessionId:"s",target:"object",objectId:"image-1",quality:"detail"});
  assert.deepEqual(validateToolArguments("penecho_capture_canvas", {sessionId:"s",target:"region",region:{x:-1,y:2,w:3,h:4}}).region, {x:-1,y:2,w:3,h:4});
  assert.throws(() => validateToolArguments("penecho_capture_canvas", {sessionId:"s",target:"object"}), /objectId is required/);
  assert.throws(() => validateToolArguments("penecho_capture_canvas", {sessionId:"s",target:"region",region:{x:0,y:0,w:1,h:1},objectId:"extra"}), /only for object capture/);
  assert.throws(() => validateToolArguments("penecho_capture_canvas", {sessionId:"s",target:"selection",region:{x:0,y:0,w:1,h:1}}), /only for region capture/);
  assert.deepEqual(validateToolArguments("penecho_read_messages", {sessionId:"s"}), {sessionId:"s",after:0,limit:20});
  assert.throws(() => validateToolArguments("penecho_ack_messages", {sessionId:"s",ids:["a","a"],status:"done"}), /duplicates/);
  for (const name of ["penecho_open_canvas","penecho_find_canvases","penecho_list_files","penecho_read_file","penecho_patch_file","penecho_edit_canvas","penecho_capture_canvas","penecho_read_messages","penecho_ack_messages"]) assert.ok(TOOLS.some(tool => tool.name === name));
});
