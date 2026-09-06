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
