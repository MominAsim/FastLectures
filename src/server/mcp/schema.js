"use strict";

const MAX_TITLE_CHARS = 120;
const MAX_SUMMARY_CHARS = 2_000;
const MAX_HTML_CHARS = 200_000;
const MAX_HTML_BYTES = 800_000;
const MAX_STEPS = 24;
const MAX_EVENTS_PER_UPDATE = 20;
const MAX_FEEDBACK_ENTRIES = 50;
const MAX_DRAW_ITEMS = 24;
const MAX_DRAW_POINTS = 256;
const MAX_DRAW_POINTS_TOTAL = 2_048;
const DRAW_TYPES = new Set(["text", "rect", "ellipse", "line", "arrow", "path"]);
const DRAW_NODE_TYPES = new Set(["text", "rect", "ellipse"]);
const COLOR_PATTERN = /^(?:#[0-9A-Fa-f]{3}|#[0-9A-Fa-f]{6}|#[0-9A-Fa-f]{8}|transparent)$/;
const SESSION_STATUSES = new Set(["working", "waiting", "done", "error"]);
const STEP_STATUSES = new Set(["pending", "working", "done", "error"]);
const EVENT_KINDS = new Set(["progress", "evidence", "info", "warning", "error"]);

class McpBridgeError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "McpBridgeError";
    this.code = code;
    this.status = status;
  }
}

function invalid(message) {
  throw new McpBridgeError("invalid_arguments", message, 400);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object.`);
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(`${label} contains an unsupported field: ${key}.`);
}

function string(value, label, { min = 1, max = 128, optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || value.length < min || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid(`${label} is invalid.`);
  return value;
}

function finiteNumber(value, label, { min, max, optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) invalid(`${label} is invalid.`);
  return value;
}

function integer(value, label, { min, max, optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${label} is invalid.`);
  return value;
}

function enumValue(value, values, label, optional = false) {
  if (value === undefined && optional) return undefined;
  if (!values.has(value)) invalid(`${label} is invalid.`);
  return value;
}

function drawText(value, label) {
  if (typeof value !== "string" || !value.length || value.length > 1_000 || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(value)) invalid(`${label} is invalid.`);
  return value;
}

function color(value, label, optional = false) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !COLOR_PATTERN.test(value)) invalid(`${label} is invalid.`);
  return value;
}

function validatePoint(value, label) {
  object(value, label);
  exactKeys(value, new Set(["x", "y"]), label);
  return {
    x:finiteNumber(value.x, `${label}.x`, { min:0, max:2_400 }),
    y:finiteNumber(value.y, `${label}.y`, { min:0, max:2_400 }),
  };
}

function validatePoints(value, label, { exact } = {}) {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_DRAW_POINTS || exact !== undefined && value.length !== exact) invalid(`${label} is invalid.`);
  return value.map((entry, index) => validatePoint(entry, `${label}[${index}]`));
}

function optionalPair(input, first, second, label) {
  if ((input[first] === undefined) !== (input[second] === undefined)) invalid(`${label} must be provided together.`);
}

function validateDrawItems(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_DRAW_ITEMS) invalid("items is invalid.");
  const ids = new Set();
  let totalPoints = 0;
  const items = value.map((entry, index) => {
    const label = `items[${index}]`;
    object(entry, label);
    const type = enumValue(entry.type, DRAW_TYPES, `${label}.type`);
    const common = new Set(["id", "type", "color", "fill", "strokeWidth"]);
    const allowed = DRAW_NODE_TYPES.has(type)
      ? new Set([...common, "text", "x", "y", "width", "height", "fontSize"])
        : type === "path"
          ? new Set([...common, "points"])
          : new Set([...common, "points", "from", "to"]);
    exactKeys(entry, allowed, label);
    const id = string(entry.id, `${label}.id`, { max:64 });
    if (ids.has(id)) invalid(`Duplicate item id: ${id}.`);
    ids.add(id);
    const output = { id, type };
    if (entry.color !== undefined) output.color = color(entry.color, `${label}.color`);
    if (entry.fill !== undefined) output.fill = color(entry.fill, `${label}.fill`);
    if (entry.strokeWidth !== undefined) output.strokeWidth = finiteNumber(entry.strokeWidth, `${label}.strokeWidth`, { min:1, max:12 });
    if (DRAW_NODE_TYPES.has(type)) {
      optionalPair(entry, "x", "y", `${label}.x and ${label}.y`);
      if (entry.x !== undefined) {
        output.x = finiteNumber(entry.x, `${label}.x`, { min:0, max:2_400 });
        output.y = finiteNumber(entry.y, `${label}.y`, { min:0, max:2_400 });
      }
      const minimumSize = type === "text" ? 8 : 80;
      if (entry.width !== undefined) output.width = finiteNumber(entry.width, `${label}.width`, { min:minimumSize, max:1_200 });
      if (entry.height !== undefined) output.height = finiteNumber(entry.height, `${label}.height`, { min:minimumSize, max:1_200 });
      if (type === "text" || entry.text !== undefined) output.text = drawText(entry.text, `${label}.text`);
      if (entry.fontSize !== undefined) output.fontSize = finiteNumber(entry.fontSize, `${label}.fontSize`, { min:12, max:64 });
    } else if (type === "path") {
      output.points = validatePoints(entry.points, `${label}.points`);
      totalPoints += output.points.length;
    } else {
      optionalPair(entry, "from", "to", `${label}.from and ${label}.to`);
      if (entry.from !== undefined) {
        if (entry.points !== undefined) invalid(`${label}.points cannot be combined with from and to.`);
        output.from = string(entry.from, `${label}.from`, { max:64 });
        output.to = string(entry.to, `${label}.to`, { max:64 });
        if (output.from === output.to) invalid(`${label}.from and ${label}.to must refer to different items.`);
      } else {
        output.points = validatePoints(entry.points, `${label}.points`, { exact:2 });
        totalPoints += output.points.length;
      }
    }
    return output;
  });
  if (totalPoints > MAX_DRAW_POINTS_TOTAL) invalid(`items contain more than ${MAX_DRAW_POINTS_TOTAL} points.`);
  const nodes = new Map(items.filter(item => DRAW_NODE_TYPES.has(item.type)).map(item => [item.id, item]));
  for (const [index, item] of items.entries()) {
    if (item.from === undefined) continue;
    if (!nodes.has(item.from) || !nodes.has(item.to)) invalid(`items[${index}].from and items[${index}].to must refer to text, rect, or ellipse items in this batch.`);
  }
  return items;
}

function validateDomainPair(input, minKey, maxKey) {
  optionalPair(input, minKey, maxKey, `${minKey} and ${maxKey}`);
  if (input[minKey] === undefined) return {};
  const minimum = finiteNumber(input[minKey], minKey, { min:-1_000_000, max:1_000_000 });
  const maximum = finiteNumber(input[maxKey], maxKey, { min:-1_000_000, max:1_000_000 });
  if (minimum >= maximum || maximum - minimum < 0.000001) invalid(`${minKey} and ${maxKey} define an invalid domain.`);
  return { [minKey]:minimum, [maxKey]:maximum };
}

function validateSteps(value) {
  if (!Array.isArray(value) || value.length > MAX_STEPS) invalid("steps is invalid.");
  return value.map((entry, index) => {
    object(entry, `steps[${index}]`);
    exactKeys(entry, new Set(["id", "label", "status"]), `steps[${index}]`);
    return {
      id:string(entry.id, `steps[${index}].id`, { max:64 }),
      label:string(entry.label, `steps[${index}].label`, { max:160 }),
      ...(entry.status === undefined ? {} : { status:enumValue(entry.status, STEP_STATUSES, `steps[${index}].status`) }),
    };
  });
}

function validateEvents(value) {
  if (!Array.isArray(value) || value.length > MAX_EVENTS_PER_UPDATE) invalid("events is invalid.");
  return value.map((entry, index) => {
    object(entry, `events[${index}]`);
    exactKeys(entry, new Set(["id", "text", "kind"]), `events[${index}]`);
    return {
      id:string(entry.id, `events[${index}].id`, { max:64 }),
      text:string(entry.text, `events[${index}].text`, { max:500 }),
      ...(entry.kind === undefined ? {} : { kind:enumValue(entry.kind, EVENT_KINDS, `events[${index}].kind`) }),
    };
  });
}

const validators = {
  penecho_list_canvases(input) {
    object(input, "arguments");
    exactKeys(input, new Set(), "arguments");
    return {};
  },
  penecho_start_session(input) {
    object(input, "arguments");
    exactKeys(input, new Set(["canvasId", "instanceId", "title", "client", "sessionKey"]), "arguments");
    return {
      canvasId:string(input.canvasId, "canvasId"),
      instanceId:string(input.instanceId, "instanceId"),
      title:string(input.title, "title", { max:MAX_TITLE_CHARS }),
      ...(input.client === undefined ? {} : { client:string(input.client, "client", { max:120 }) }),
      ...(input.sessionKey === undefined ? {} : { sessionKey:string(input.sessionKey, "sessionKey", { max:128 }) }),
    };
  },
  penecho_update_session(input) {
    object(input, "arguments");
    exactKeys(input, new Set(["sessionId", "title", "status", "summary", "steps", "events"]), "arguments");
    const output = { sessionId:string(input.sessionId, "sessionId") };
    if (input.title !== undefined) output.title = string(input.title, "title", { max:MAX_TITLE_CHARS });
    if (input.status !== undefined) output.status = enumValue(input.status, SESSION_STATUSES, "status");
    if (input.summary !== undefined) output.summary = string(input.summary, "summary", { min:0, max:MAX_SUMMARY_CHARS });
    if (input.steps !== undefined) output.steps = validateSteps(input.steps);
    if (input.events !== undefined) output.events = validateEvents(input.events);
    if (Object.keys(output).length === 1) invalid("At least one session update field is required.");
    return output;
  },
  penecho_present_widget(input) {
    object(input, "arguments");
    exactKeys(input, new Set(["sessionId", "artifactId", "title", "html", "width", "height", "capture", "quality"]), "arguments");
    const html = typeof input.html === "string" ? input.html : invalid("html is invalid.");
    if (!html || html.length > MAX_HTML_CHARS || Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) invalid("html is invalid or too large.");
    if (input.capture !== undefined && typeof input.capture !== "boolean") invalid("capture is invalid.");
    if (input.quality !== undefined && input.capture !== true) invalid("quality requires capture to be true.");
    return {
      sessionId:string(input.sessionId, "sessionId"),
      artifactId:string(input.artifactId, "artifactId"),
      title:string(input.title, "title", { max:MAX_TITLE_CHARS }),
      html,
      ...(input.width === undefined ? {} : { width:Math.round(finiteNumber(input.width, "width", { min:300, max:4096 })) }),
      ...(input.height === undefined ? {} : { height:Math.round(finiteNumber(input.height, "height", { min:200, max:4096 })) }),
      ...(input.capture === undefined ? {} : { capture:input.capture }),
      ...(input.quality === undefined ? {} : { quality:enumValue(input.quality, new Set(["basic", "detail"]), "quality") }),
    };
  },
  penecho_capture_widget(input) {
    object(input, "arguments");
    exactKeys(input, new Set(["sessionId", "artifactId", "quality"]), "arguments");
    return {
      sessionId:string(input.sessionId, "sessionId"),
      artifactId:string(input.artifactId, "artifactId"),
      ...(input.quality === undefined ? {} : { quality:enumValue(input.quality, new Set(["basic", "detail"]), "quality") }),
    };
  },
  penecho_draw(input) {
    object(input, "arguments");
    exactKeys(input, new Set(["sessionId", "artifactId", "title", "items", "capture"]), "arguments");
    if (input.capture !== undefined && typeof input.capture !== "boolean") invalid("capture is invalid.");
    return {
      sessionId:string(input.sessionId, "sessionId"),
      artifactId:string(input.artifactId, "artifactId"),
      title:string(input.title, "title", { max:MAX_TITLE_CHARS }),
      items:validateDrawItems(input.items),
      ...(input.capture === undefined ? {} : { capture:input.capture }),
    };
  },
  penecho_plot(input) {
    object(input, "arguments");
    exactKeys(input, new Set(["sessionId", "artifactId", "title", "expression", "width", "height", "xMin", "xMax", "yMin", "yMax", "color", "capture"]), "arguments");
    if (input.capture !== undefined && typeof input.capture !== "boolean") invalid("capture is invalid.");
    const xDomain = validateDomainPair(input, "xMin", "xMax");
    const yDomain = validateDomainPair(input, "yMin", "yMax");
    if (input.yMin !== undefined && input.xMin === undefined) invalid("yMin and yMax require xMin and xMax.");
    return {
      sessionId:string(input.sessionId, "sessionId"),
      artifactId:string(input.artifactId, "artifactId"),
      title:string(input.title, "title", { max:MAX_TITLE_CHARS }),
      expression:string(input.expression, "expression", { max:180 }),
      ...(input.width === undefined ? {} : { width:Math.round(finiteNumber(input.width, "width", { min:300, max:1_600 })) }),
      ...(input.height === undefined ? {} : { height:Math.round(finiteNumber(input.height, "height", { min:200, max:1_200 })) }),
      ...xDomain,
      ...yDomain,
      ...(input.color === undefined ? {} : { color:color(input.color, "color") }),
      ...(input.capture === undefined ? {} : { capture:input.capture }),
    };
  },
  penecho_read_feedback(input) {
    object(input, "arguments");
    exactKeys(input, new Set(["sessionId", "after", "limit", "capture"]), "arguments");
    if (input.capture !== undefined && typeof input.capture !== "boolean") invalid("capture is invalid.");
    return {
      sessionId:string(input.sessionId, "sessionId"),
      ...(input.after === undefined ? {} : { after:integer(input.after, "after", { min:0, max:Number.MAX_SAFE_INTEGER }) }),
      limit:input.limit === undefined ? 20 : integer(input.limit, "limit", { min:1, max:MAX_FEEDBACK_ENTRIES }),
      capture:input.capture !== false,
    };
  },
  penecho_inspect_session(input) {
    object(input, "arguments");
    exactKeys(input, new Set(["sessionId"]), "arguments");
    return { sessionId:string(input.sessionId, "sessionId") };
  },
  penecho_close_session(input) {
    object(input, "arguments");
    exactKeys(input, new Set(["sessionId"]), "arguments");
    return { sessionId:string(input.sessionId, "sessionId") };
  },
};

const TOOLS = [
  {
    name:"penecho_list_canvases",
    description:"List PenEcho canvases whose browser tabs explicitly opted in to this local MCP instance.",
    inputSchema:{ type:"object", additionalProperties:false, properties:{} },
  },
  {
    name:"penecho_start_session",
    description:"Start a visible work session on one exact opted-in PenEcho canvas. Use concise public plan and progress text; never send private chain-of-thought.",
    inputSchema:{ type:"object", additionalProperties:false, required:["canvasId", "instanceId", "title"], properties:{ canvasId:{type:"string",minLength:1,maxLength:128}, instanceId:{type:"string",minLength:1,maxLength:128}, title:{type:"string",minLength:1,maxLength:MAX_TITLE_CHARS}, client:{type:"string",minLength:1,maxLength:120}, sessionKey:{type:"string",minLength:1,maxLength:128} } },
  },
  {
    name:"penecho_update_session",
    description:"Queue a bounded public progress update for a PenEcho session. Batch updates at meaningful milestones. The acknowledgement says queued; inspect_session reports whether the browser applied it and whether its surface was visible, without claiming pixel-level paint proof.",
    inputSchema:{ type:"object", additionalProperties:false, required:["sessionId"], properties:{ sessionId:{type:"string",minLength:1,maxLength:128}, title:{type:"string",minLength:1,maxLength:MAX_TITLE_CHARS}, status:{type:"string",enum:[...SESSION_STATUSES]}, summary:{type:"string",maxLength:MAX_SUMMARY_CHARS}, steps:{type:"array",maxItems:MAX_STEPS,items:{type:"object",additionalProperties:false,required:["id","label"],properties:{id:{type:"string",minLength:1,maxLength:64},label:{type:"string",minLength:1,maxLength:160},status:{type:"string",enum:[...STEP_STATUSES]}}}}, events:{type:"array",maxItems:MAX_EVENTS_PER_UPDATE,items:{type:"object",additionalProperties:false,required:["id","text"],properties:{id:{type:"string",minLength:1,maxLength:64},text:{type:"string",minLength:1,maxLength:500},kind:{type:"string",enum:[...EVENT_KINDS]}}}} } },
  },
  {
    name:"penecho_present_widget",
    description:"Present an HTML widget in the exact PenEcho session and wait for its application result. For design validation, set capture:true to present and capture the same widget in one tool roundtrip; ordinary presentation remains screenshot-free and does not claim pixel verification.",
    inputSchema:{ type:"object", additionalProperties:false, required:["sessionId","artifactId","title","html"], properties:{sessionId:{type:"string",minLength:1,maxLength:128},artifactId:{type:"string",minLength:1,maxLength:128},title:{type:"string",minLength:1,maxLength:MAX_TITLE_CHARS},html:{type:"string",minLength:1,maxLength:MAX_HTML_CHARS},width:{type:"number",minimum:300,maximum:4096},height:{type:"number",minimum:200,maximum:4096},capture:{type:"boolean",default:false},quality:{type:"string",enum:["basic","detail"]}}, allOf:[{if:{required:["quality"]},then:{required:["capture"],properties:{capture:{const:true}}}}] },
  },
  {
    name:"penecho_capture_widget",
    description:"Capture one requested widget from the exact PenEcho session. No screenshot is taken unless this tool is called.",
    inputSchema:{ type:"object", additionalProperties:false, required:["sessionId","artifactId"], properties:{sessionId:{type:"string",minLength:1,maxLength:128},artifactId:{type:"string",minLength:1,maxLength:128},quality:{type:"string",enum:["basic","detail"]}} },
  },
  {
    name:"penecho_draw",
    description:"Create or replace a stable artifact with native Canvas text and rasterized shapes. Rectangles and ellipses may include labels and have an 80 px minimum footprint. The result is saved with the Canvas and can be moved or resized; MCP can replace it by artifactId, but it has no editable vector handles and is not an iframe Widget. Set capture:true only when a bounded screenshot is needed. A capture error leaves the applied artifact in place, so retry with the same artifactId.",
    inputSchema:{ type:"object", additionalProperties:false, required:["sessionId","artifactId","title","items"], properties:{ sessionId:{type:"string",minLength:1,maxLength:128}, artifactId:{type:"string",minLength:1,maxLength:128}, title:{type:"string",minLength:1,maxLength:MAX_TITLE_CHARS}, items:{type:"array",minItems:1,maxItems:MAX_DRAW_ITEMS,items:{type:"object",additionalProperties:false,required:["id","type"],properties:{id:{type:"string",minLength:1,maxLength:64},type:{type:"string",enum:[...DRAW_TYPES]},text:{type:"string",minLength:1,maxLength:1_000},x:{type:"number",minimum:0,maximum:2_400},y:{type:"number",minimum:0,maximum:2_400},width:{type:"number",minimum:8,maximum:1_200},height:{type:"number",minimum:8,maximum:1_200},color:{type:"string",pattern:COLOR_PATTERN.source},fill:{type:"string",pattern:COLOR_PATTERN.source},fontSize:{type:"number",minimum:12,maximum:64},strokeWidth:{type:"number",minimum:1,maximum:12},points:{type:"array",minItems:2,maxItems:MAX_DRAW_POINTS,items:{type:"object",additionalProperties:false,required:["x","y"],properties:{x:{type:"number",minimum:0,maximum:2_400},y:{type:"number",minimum:0,maximum:2_400}}}},from:{type:"string",minLength:1,maxLength:64},to:{type:"string",minLength:1,maxLength:64}},allOf:[{if:{required:["type"],properties:{type:{enum:["rect","ellipse"]}}},then:{properties:{width:{minimum:80},height:{minimum:80}}}}]}}, capture:{type:"boolean",default:false} } },
  },
  {
    name:"penecho_plot",
    description:"Create or replace a stable native Canvas plot from a bounded mathematical expression. PenEcho compiles it safely without eval. The raster plot is saved with the Canvas and can be moved or resized; MCP can replace it by artifactId, but it has no editable vector handles and is not an iframe Widget. Set capture:true only when a bounded screenshot is needed. A capture error leaves the applied artifact in place, so retry with the same artifactId.",
    inputSchema:{ type:"object", additionalProperties:false, required:["sessionId","artifactId","title","expression"], properties:{sessionId:{type:"string",minLength:1,maxLength:128},artifactId:{type:"string",minLength:1,maxLength:128},title:{type:"string",minLength:1,maxLength:MAX_TITLE_CHARS},expression:{type:"string",minLength:1,maxLength:180},width:{type:"number",minimum:300,maximum:1_600},height:{type:"number",minimum:200,maximum:1_200},xMin:{type:"number",minimum:-1_000_000,maximum:1_000_000},xMax:{type:"number",minimum:-1_000_000,maximum:1_000_000},yMin:{type:"number",minimum:-1_000_000,maximum:1_000_000},yMax:{type:"number",minimum:-1_000_000,maximum:1_000_000},color:{type:"string",pattern:COLOR_PATTERN.source},capture:{type:"boolean",default:false}} },
  },
  {
    name:"penecho_read_feedback",
    description:"Read bounded user feedback added to the exact PenEcho session since its start baseline or a supplied cursor. This does not consume feedback. A bounded screenshot is returned with changes by default; set capture:false for metadata only.",
    inputSchema:{ type:"object", additionalProperties:false, required:["sessionId"], properties:{sessionId:{type:"string",minLength:1,maxLength:128},after:{type:"integer",minimum:0},limit:{type:"integer",minimum:1,maximum:MAX_FEEDBACK_ENTRIES,default:20},capture:{type:"boolean",default:true}} },
  },
  { name:"penecho_inspect_session", description:"Inspect one owned PenEcho session and its browser state.", inputSchema:{type:"object",additionalProperties:false,required:["sessionId"],properties:{sessionId:{type:"string",minLength:1,maxLength:128}}} },
  { name:"penecho_close_session", description:"Close one owned PenEcho session on its exact canvas.", inputSchema:{type:"object",additionalProperties:false,required:["sessionId"],properties:{sessionId:{type:"string",minLength:1,maxLength:128}}} },
];

function validateToolArguments(name, input) {
  const validate = validators[name];
  if (!validate) throw new McpBridgeError("tool_not_found", `Unknown tool: ${String(name || "")}.`, 404);
  return validate(input);
}

module.exports = {
  MAX_EVENTS_PER_UPDATE,
  MAX_FEEDBACK_ENTRIES,
  MAX_HTML_CHARS,
  MAX_HTML_BYTES,
  McpBridgeError,
  TOOLS,
  validateToolArguments,
};
