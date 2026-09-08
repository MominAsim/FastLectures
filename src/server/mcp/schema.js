"use strict";

const { VISUAL_INSTRUCTIONS } = require("./guidance.js");

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
const MAX_FILE_BYTES = 800_000;
const MAX_FILES_PER_PAGE = 100;
const MAX_MESSAGES_PER_PAGE = 50;
const MAX_REQUEST_IDS = 50;
const DRAW_TYPES = new Set(["text", "rect", "ellipse", "line", "arrow", "path"]);
const DRAW_NODE_TYPES = new Set(["text", "rect", "ellipse"]);
const COLOR_PATTERN = /^(?:#[0-9A-Fa-f]{3}|#[0-9A-Fa-f]{6}|#[0-9A-Fa-f]{8}|transparent)$/;
const SESSION_STATUSES = new Set(["working", "waiting", "done", "error"]);
const STEP_STATUSES = new Set(["pending", "working", "done", "error"]);
const EVENT_KINDS = new Set(["progress", "evidence", "info", "warning", "error"]);
const STORAGE_LOCATIONS = new Set(["device", "server", "cloud"]);
const EDIT_ACTIONS = new Set(["create_text", "move", "resize", "delete", "erase_ink", "replace_image", "show"]);
const MESSAGE_STATUSES = new Set(["received", "working", "done", "error"]);
const CAPTURE_TARGETS = new Set(["canvas", "viewport", "selection", "region", "object"]);
const CAPTURE_QUALITIES = new Set(["basic", "detail"]);
const PRESENTATION_INTENTS = new Set(["explain", "deliver", "compare", "review", "inspect"]);
const PRESENTATION_ROLES = new Set(["primary", "supporting", "alternative"]);
const PRESENTATION_SIZES = new Set(["base", "wide", "tall", "large", "page"]);
const PRESENTATION_RELATIONS = new Set(["below", "beside"]);
const PRESENTATION_ATTENTION = new Set(["quiet", "normal", "request"]);
const PRESENTATION_VIEWPORTS = Object.freeze({
  base:Object.freeze({width:480,height:360}),
  wide:Object.freeze({width:992,height:360}),
  tall:Object.freeze({width:480,height:752}),
  large:Object.freeze({width:992,height:752}),
  page:Object.freeze({width:1_200,height:800}),
});

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

function bool(value, label, defaultValue) {
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") invalid(`${label} is invalid.`);
  return value;
}

function validatePresentation(value, { kind, capture, hasExplicitDimensions = false } = {}) {
  const supplied = value !== undefined;
  if (!supplied) return undefined;
  const input = supplied ? object(value, "presentation") : {};
  exactKeys(input, new Set(["intent", "role", "size", "relativeTo", "relation", "attention"]), "presentation");
  const intent = input.intent === undefined ? "deliver" : enumValue(input.intent, PRESENTATION_INTENTS, "presentation.intent");
  const role = input.role === undefined ? "primary" : enumValue(input.role, PRESENTATION_ROLES, "presentation.role");
  if (intent === "inspect" && kind !== "widget") invalid("presentation.intent inspect is valid only for widgets.");
  if (intent === "inspect" && capture !== true) invalid("presentation.intent inspect requires capture to be true.");
  if (kind === "draw" && input.size !== undefined) invalid("presentation.size is not valid for drawings.");
  if (input.size !== undefined && hasExplicitDimensions) invalid("presentation.size cannot be combined with explicit width or height.");
  const size = kind === "draw" || hasExplicitDimensions
    ? undefined
    : input.size === undefined ? "base" : enumValue(input.size, PRESENTATION_SIZES, "presentation.size");
  const relativeTo = input.relativeTo === undefined ? undefined : string(input.relativeTo, "presentation.relativeTo", {max:128});
  if (input.relation !== undefined && relativeTo === undefined) invalid("presentation.relation requires presentation.relativeTo.");
  if (intent === "inspect" && (relativeTo !== undefined || input.relation !== undefined)) invalid("presentation.intent inspect cannot use relativeTo or relation.");
  const relation = intent === "inspect" || relativeTo === undefined ? undefined : input.relation === undefined
    ? intent === "compare" ? "beside" : "below"
    : enumValue(input.relation, PRESENTATION_RELATIONS, "presentation.relation");
  const defaultAttention = intent === "inspect" ? "quiet" : intent === "review" ? "request" : role === "primary" ? "normal" : "quiet";
  const attention = input.attention === undefined ? defaultAttention : enumValue(input.attention, PRESENTATION_ATTENTION, "presentation.attention");
  if (intent === "inspect" && attention !== "quiet") invalid("presentation.intent inspect requires quiet attention.");
  return {
    intent,
    role,
    ...(size === undefined ? {} : {size}),
    ...(relativeTo === undefined ? {} : {relativeTo}),
    ...(relation === undefined ? {} : {relation}),
    attention,
  };
}

function presentationDimensions(input, presentation, {maxWidth,maxHeight}) {
  const preset = presentation?.size === undefined ? PRESENTATION_VIEWPORTS.base : PRESENTATION_VIEWPORTS[presentation.size];
  const width = input.width === undefined ? preset.width : Math.round(finiteNumber(input.width, "width", {min:300,max:maxWidth}));
  const height = input.height === undefined ? preset.height : Math.round(finiteNumber(input.height, "height", {min:200,max:maxHeight}));
  if (width > maxWidth || height > maxHeight) invalid("presentation.size exceeds this tool's viewport limits.");
  return {width,height};
}

function region(value, label = "region", optional = false) {
  if (value === undefined && optional) return undefined;
  object(value, label);
  exactKeys(value, new Set(["x", "y", "w", "h"]), label);
  return {
    x:finiteNumber(value.x, `${label}.x`, { min:-1_000_000_000, max:1_000_000_000 }),
    y:finiteNumber(value.y, `${label}.y`, { min:-1_000_000_000, max:1_000_000_000 }),
    w:finiteNumber(value.w, `${label}.w`, { min:0.001, max:1_000_000_000 }),
    h:finiteNumber(value.h, `${label}.h`, { min:0.001, max:1_000_000_000 }),
  };
}

function virtualPath(value, label = "path", { defaultValue } = {}) {
  if (value === undefined && defaultValue !== undefined) value = defaultValue;
  if (typeof value !== "string" || !value.length || value.length > 1_024 || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) invalid(`${label} is invalid.`);
  const normalized = value.replace(/^\/+/, "");
  if (!normalized) return "/";
  if (normalized.split("/").some(part => part === ".." || part === "." || !part)) invalid(`${label} is invalid.`);
  let decoded;
  try { decoded = decodeURIComponent(normalized); } catch { invalid(`${label} is invalid.`); }
  if (/%(?:00|2f|5c)/i.test(normalized) || decoded.includes("\\") || decoded.includes("\0") || decoded.split("/").some(part => part === ".." || part === "." || !part)) invalid(`${label} is invalid.`);
  return normalized ? `/${normalized}` : "/";
}

function locator(value) {
  object(value, "locator");
  exactKeys(value, new Set(["location", "id"]), "locator");
  return { location:enumValue(value.location, STORAGE_LOCATIONS, "locator.location"), id:string(value.id, "locator.id", { max:512 }) };
}

function boundedContent(value, label) {
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_FILE_BYTES) invalid(`${label} is invalid or too large.`);
  return value;
}

function imageSource(value) {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value, "utf8") > MAX_FILE_BYTES) invalid("source is invalid or too large.");
  if (/^penecho-ref:objects\/[A-Za-z0-9._~%-]{1,512}\/image$/.test(value)) return value;
  const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) invalid("source must be an image data URL or an authorized penecho-ref:objects/<id>/image reference.");
  const bytes = Buffer.from(match[1], "base64");
  if (!bytes.length || bytes.length > MAX_FILE_BYTES || bytes.toString("base64").replace(/=+$/, "") !== match[1].replace(/=+$/, "")) invalid("source is invalid or too large.");
  return value;
}

const validators = {
  penecho_list_canvases(input) {
    object(input, "arguments");
    exactKeys(input, new Set(), "arguments");
    return {};
  },
  penecho_open_canvas(input) {
    object(input, "arguments");
    exactKeys(input, new Set(["instanceId", "canvasId", "documentId", "locator", "create", "title", "requestId", "show"]), "arguments");
    const output = {
      instanceId:string(input.instanceId, "instanceId"),
      canvasId:string(input.canvasId, "canvasId"),
      requestId:string(input.requestId, "requestId", { max:128 }),
      show:bool(input.show, "show", false),
    };
    if (input.documentId !== undefined) output.documentId = string(input.documentId, "documentId", { max:256 });
    if (input.locator !== undefined) output.locator = locator(input.locator);
    if (input.create !== undefined) output.create = bool(input.create, "create", false);
    if (input.title !== undefined) output.title = string(input.title, "title", { max:MAX_TITLE_CHARS });
    const targets = Number(output.documentId !== undefined) + Number(output.locator !== undefined);
    if (output.create !== true && targets === 0) invalid("Provide create:true, documentId, or locator.");
    if (output.create === true && targets !== 0) invalid("create cannot be combined with documentId or locator.");
    if (output.create !== true && output.title !== undefined) invalid("title is valid only with create:true.");
    return output;
  },
  penecho_find_canvases(input) {
    object(input, "arguments");
    exactKeys(input, new Set(["instanceId", "canvasId", "documentId"]), "arguments");
    return {
      instanceId:string(input.instanceId, "instanceId"),
      canvasId:string(input.canvasId, "canvasId"),
      ...(input.documentId === undefined ? {} : {documentId:string(input.documentId, "documentId", { max:256 })}),
    };
  },
  penecho_start_session(input) {
    object(input, "arguments");
    exactKeys(input, new Set(["canvasId", "instanceId", "documentId", "takeover", "title", "client", "sessionKey"]), "arguments");
    return {
      canvasId:string(input.canvasId, "canvasId"),
      instanceId:string(input.instanceId, "instanceId"),
      title:string(input.title, "title", { max:MAX_TITLE_CHARS }),
      ...(input.documentId === undefined ? {} : { documentId:string(input.documentId, "documentId", { max:256 }) }),
      ...(input.takeover === undefined ? {} : { takeover:bool(input.takeover, "takeover", false) }),
      ...(input.client === undefined ? {} : { client:string(input.client, "client", { max:120 }) }),
      ...(input.sessionKey === undefined ? {} : { sessionKey:string(input.sessionKey, "sessionKey", { max:128 }) }),
    };
  },
  penecho_list_files(input) {
    object(input, "arguments");
    exactKeys(input, new Set(["sessionId", "path", "region", "offset", "limit"]), "arguments");
    return {
      sessionId:string(input.sessionId, "sessionId"),
      path:virtualPath(input.path, "path", { defaultValue:"/" }),
      ...(input.region === undefined ? {} : {region:region(input.region)}),
      offset:input.offset === undefined ? 0 : integer(input.offset, "offset", {min:0,max:Number.MAX_SAFE_INTEGER}),
      limit:input.limit === undefined ? 50 : integer(input.limit, "limit", {min:1,max:MAX_FILES_PER_PAGE}),
    };
  },
  penecho_read_file(input) {
    object(input, "arguments");
    exactKeys(input, new Set(["sessionId", "path", "startLine", "endLine"]), "arguments");
    const output = { sessionId:string(input.sessionId, "sessionId"), path:virtualPath(input.path) };
    if (input.startLine !== undefined) output.startLine = integer(input.startLine, "startLine", {min:1,max:Number.MAX_SAFE_INTEGER});
    if (input.endLine !== undefined) output.endLine = integer(input.endLine, "endLine", {min:1,max:Number.MAX_SAFE_INTEGER});
    if (output.endLine !== undefined && output.startLine !== undefined && output.endLine < output.startLine) invalid("endLine must be greater than or equal to startLine.");
    return output;
  },
  penecho_patch_file(input) {
    object(input, "arguments");
    exactKeys(input, new Set(["sessionId", "path", "contentHash", "patch", "requestId"]), "arguments");
    return {
      sessionId:string(input.sessionId, "sessionId"),
      path:virtualPath(input.path),
      contentHash:string(input.contentHash, "contentHash", { max:256 }),
      patch:boundedContent(input.patch, "patch"),
      requestId:string(input.requestId, "requestId", { max:128 }),
    };
  },
  penecho_edit_canvas(input) {
    object(input, "arguments");
    exactKeys(input, new Set(["sessionId", "requestId", "action", "objectId", "text", "source", "region", "width", "height", "baseRevision"]), "arguments");
    const action = enumValue(input.action, EDIT_ACTIONS, "action");
    const output = {sessionId:string(input.sessionId, "sessionId"),requestId:string(input.requestId, "requestId", {max:128}),action};
    if (input.objectId !== undefined) output.objectId = string(input.objectId, "objectId", {max:128});
    if (input.text !== undefined) output.text = boundedContent(input.text, "text");
    if (input.source !== undefined) output.source = imageSource(input.source);
    if (input.region !== undefined) output.region = region(input.region);
    if (input.width !== undefined) output.width = finiteNumber(input.width, "width", {min:1,max:1_000_000_000});
    if (input.height !== undefined) output.height = finiteNumber(input.height, "height", {min:1,max:1_000_000_000});
    if (input.baseRevision !== undefined) output.baseRevision = integer(input.baseRevision, "baseRevision", {min:0,max:Number.MAX_SAFE_INTEGER});
    const keys = new Set(Object.keys(output).filter(key => !["sessionId", "requestId", "action"].includes(key)));
    const requireOnly = (required, optional = []) => {
      for (const key of required) if (!keys.has(key)) invalid(`${key} is required for ${action}.`);
      for (const key of keys) if (![...required, ...optional].includes(key)) invalid(`${key} is not valid for ${action}.`);
    };
    if (action === "create_text") requireOnly(["text"], ["region"]);
    if (action === "move") requireOnly(["objectId", "region", "baseRevision"]);
    if (action === "resize") requireOnly(["objectId", "width", "height", "baseRevision"]);
    if (action === "delete") requireOnly(["objectId", "baseRevision"]);
    if (action === "erase_ink") requireOnly(["region", "baseRevision"]);
    if (action === "replace_image") requireOnly(["objectId", "source", "baseRevision"], ["width", "height"]);
    if (action === "replace_image" && (keys.has("width") !== keys.has("height"))) invalid("width and height must be provided together.");
    if (action === "show") requireOnly([], ["objectId"]);
    return output;
  },
  penecho_capture_canvas(input) {
    object(input, "arguments");
    exactKeys(input, new Set(["sessionId", "target", "objectId", "region", "quality"]), "arguments");
    const target = input.target === undefined ? "viewport" : enumValue(input.target, CAPTURE_TARGETS, "target");
    const output = {
      sessionId:string(input.sessionId, "sessionId"),
      target,
      quality:input.quality === undefined ? "basic" : enumValue(input.quality, CAPTURE_QUALITIES, "quality"),
    };
    if (input.objectId !== undefined) output.objectId = string(input.objectId, "objectId", {max:128});
    if (input.region !== undefined) output.region = region(input.region);
    if (target === "object" && output.objectId === undefined) invalid("objectId is required for object capture.");
    if (target === "region" && output.region === undefined) invalid("region is required for region capture.");
    if (target !== "object" && output.objectId !== undefined) invalid("objectId is valid only for object capture.");
    if (target !== "region" && output.region !== undefined) invalid("region is valid only for region capture.");
    return output;
  },
  penecho_read_messages(input) {
    object(input, "arguments");
    exactKeys(input, new Set(["sessionId", "after", "limit"]), "arguments");
    return {sessionId:string(input.sessionId, "sessionId"),after:input.after === undefined ? 0 : integer(input.after, "after", {min:0,max:Number.MAX_SAFE_INTEGER}),limit:input.limit === undefined ? 20 : integer(input.limit, "limit", {min:1,max:MAX_MESSAGES_PER_PAGE})};
  },
  penecho_ack_messages(input) {
    object(input, "arguments");
    exactKeys(input, new Set(["sessionId", "ids", "status", "message"]), "arguments");
    if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > MAX_REQUEST_IDS) invalid("ids is invalid.");
    const ids = input.ids.map((id, index) => string(id, `ids[${index}]`, {max:128}));
    if (new Set(ids).size !== ids.length) invalid("ids contains duplicates.");
    return {sessionId:string(input.sessionId, "sessionId"),ids,status:enumValue(input.status, MESSAGE_STATUSES, "status"),...(input.message === undefined ? {} : {message:string(input.message, "message", {min:0,max:1_000})})};
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
    exactKeys(input, new Set(["sessionId", "artifactId", "title", "html", "width", "height", "capture", "quality", "presentation"]), "arguments");
    const html = typeof input.html === "string" ? input.html : invalid("html is invalid.");
    if (!html || html.length > MAX_HTML_CHARS || Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) invalid("html is invalid or too large.");
    if (input.capture !== undefined && typeof input.capture !== "boolean") invalid("capture is invalid.");
    if (input.quality !== undefined && input.capture !== true) invalid("quality requires capture to be true.");
    const capture = input.capture === true;
    const presentation = validatePresentation(input.presentation, {kind:"widget",capture,hasExplicitDimensions:input.width !== undefined || input.height !== undefined});
    const dimensions = presentationDimensions(input, presentation, {maxWidth:4096,maxHeight:4096});
    return {
      sessionId:string(input.sessionId, "sessionId"),
      artifactId:string(input.artifactId, "artifactId"),
      title:string(input.title, "title", { max:MAX_TITLE_CHARS }),
      html,
      ...dimensions,
      ...(presentation === undefined ? {} : {presentation}),
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
    exactKeys(input, new Set(["sessionId", "artifactId", "title", "items", "capture", "presentation"]), "arguments");
    if (input.capture !== undefined && typeof input.capture !== "boolean") invalid("capture is invalid.");
    return {
      sessionId:string(input.sessionId, "sessionId"),
      artifactId:string(input.artifactId, "artifactId"),
      title:string(input.title, "title", { max:MAX_TITLE_CHARS }),
      items:validateDrawItems(input.items),
      ...(input.presentation === undefined ? {} : {presentation:validatePresentation(input.presentation, {kind:"draw",capture:input.capture === true})}),
      ...(input.capture === undefined ? {} : { capture:input.capture }),
    };
  },
  penecho_plot(input) {
    object(input, "arguments");
    exactKeys(input, new Set(["sessionId", "artifactId", "title", "expression", "width", "height", "xMin", "xMax", "yMin", "yMax", "color", "capture", "presentation"]), "arguments");
    if (input.capture !== undefined && typeof input.capture !== "boolean") invalid("capture is invalid.");
    const xDomain = validateDomainPair(input, "xMin", "xMax");
    const yDomain = validateDomainPair(input, "yMin", "yMax");
    if (input.yMin !== undefined && input.xMin === undefined) invalid("yMin and yMax require xMin and xMax.");
    const presentation = validatePresentation(input.presentation, {kind:"plot",capture:input.capture === true,hasExplicitDimensions:input.width !== undefined || input.height !== undefined});
    const dimensions = presentationDimensions(input, presentation, {maxWidth:1_600,maxHeight:1_200});
    return {
      sessionId:string(input.sessionId, "sessionId"),
      artifactId:string(input.artifactId, "artifactId"),
      title:string(input.title, "title", { max:MAX_TITLE_CHARS }),
      expression:string(input.expression, "expression", { max:180 }),
      ...dimensions,
      ...(presentation === undefined ? {} : {presentation}),
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

function presentationSchema({allowSize = true,allowInspect = false} = {}) {
  const properties = {
    intent:{type:"string",enum:[...PRESENTATION_INTENTS].filter(value => allowInspect || value !== "inspect"),default:"deliver"},
    role:{type:"string",enum:[...PRESENTATION_ROLES],default:"primary"},
    ...(allowSize ? {size:{type:"string",enum:[...PRESENTATION_SIZES],default:"base"}} : {}),
    relativeTo:{type:"string",minLength:1,maxLength:128},
    relation:{type:"string",enum:[...PRESENTATION_RELATIONS]},
    attention:{type:"string",enum:[...PRESENTATION_ATTENTION]},
  };
  return {
    type:"object",
    additionalProperties:false,
    properties,
    allOf:[
      {if:{required:["relation"]},then:{required:["relativeTo"]}},
      ...(allowInspect ? [{
        if:{properties:{intent:{const:"inspect"}},required:["intent"]},
        then:{properties:{attention:{const:"quiet"}},not:{anyOf:[{required:["relativeTo"]},{required:["relation"]}]}},
      }] : []),
    ],
  };
}

const TOOLS = [
  {
    name:"penecho_list_canvases",
    description:"List PenEcho canvases whose browser tabs explicitly opted in to this local MCP instance.",
    inputSchema:{ type:"object", additionalProperties:false, properties:{} },
  },
  { name:"penecho_open_canvas", description:"Create or open a persistent PenEcho document through one exact opted-in browser connection. Supply documentId, locator, or both to verify an exact saved copy; create is exclusive. The current view changes only when show:true.", inputSchema:{type:"object",additionalProperties:false,required:["instanceId","canvasId","requestId"],properties:{instanceId:{type:"string",minLength:1,maxLength:128},canvasId:{type:"string",minLength:1,maxLength:128},documentId:{type:"string",minLength:1,maxLength:256},locator:{type:"object",additionalProperties:false,required:["location","id"],properties:{location:{type:"string",enum:[...STORAGE_LOCATIONS]},id:{type:"string",minLength:1,maxLength:512}}},create:{type:"boolean",default:false},title:{type:"string",minLength:1,maxLength:MAX_TITLE_CHARS},requestId:{type:"string",minLength:1,maxLength:128},show:{type:"boolean",default:false}}} },
  { name:"penecho_find_canvases", description:"Find authorized document candidates and per-provider statuses through one exact opted-in browser connection. This does not guess across PenEcho hosts.", inputSchema:{type:"object",additionalProperties:false,required:["instanceId","canvasId"],properties:{instanceId:{type:"string",minLength:1,maxLength:128},canvasId:{type:"string",minLength:1,maxLength:128},documentId:{type:"string",minLength:1,maxLength:256}}} },
  {
    name:"penecho_start_session",
    description:"Start session metadata on one exact opted-in PenEcho canvas. This creates no automatic progress board; boardObjectId may be null. Supply a concise task title; it also names an untitled Canvas without another model call. Follow the returned instructions for lightweight progress and useful spatial artifacts without delaying the first output; never send private chain-of-thought.",
    inputSchema:{ type:"object", additionalProperties:false, required:["canvasId", "instanceId", "title"], properties:{ canvasId:{type:"string",minLength:1,maxLength:128}, instanceId:{type:"string",minLength:1,maxLength:128}, documentId:{type:"string",minLength:1,maxLength:256}, takeover:{type:"boolean",default:false}, title:{type:"string",minLength:1,maxLength:MAX_TITLE_CHARS}, client:{type:"string",minLength:1,maxLength:120}, sessionKey:{type:"string",minLength:1,maxLength:128} } },
  },
  { name:"penecho_list_files", description:"List bounded virtual public files for the session document. Paths are Canvas virtual paths, never host filesystem paths.", inputSchema:{type:"object",additionalProperties:false,required:["sessionId"],properties:{sessionId:{type:"string",minLength:1,maxLength:128},path:{type:"string",default:"/",maxLength:1024},region:{type:"object",additionalProperties:false,required:["x","y","w","h"],properties:{x:{type:"number"},y:{type:"number"},w:{type:"number",exclusiveMinimum:0},h:{type:"number",exclusiveMinimum:0}}},offset:{type:"integer",minimum:0,default:0},limit:{type:"integer",minimum:1,maximum:MAX_FILES_PER_PAGE,default:50}}} },
  { name:"penecho_read_file", description:"Read bounded public source content from one virtual Canvas file. This never exposes a physical filesystem path.", inputSchema:{type:"object",additionalProperties:false,required:["sessionId","path"],properties:{sessionId:{type:"string",minLength:1,maxLength:128},path:{type:"string",minLength:1,maxLength:1024},startLine:{type:"integer",minimum:1},endLine:{type:"integer",minimum:1}}} },
  { name:"penecho_patch_file", description:"Apply one strict unified diff to an existing virtual source file. Read first, use its contentHash, and retry an unknown outcome with the same requestId. Geometry is edited separately.", inputSchema:{type:"object",additionalProperties:false,required:["sessionId","path","contentHash","patch","requestId"],properties:{sessionId:{type:"string",minLength:1,maxLength:128},path:{type:"string",minLength:1,maxLength:1024},contentHash:{type:"string",minLength:1,maxLength:256},patch:{type:"string",maxLength:MAX_FILE_BYTES},requestId:{type:"string",minLength:1,maxLength:128}}} },
  { name:"penecho_edit_canvas", description:"Perform one bounded idempotent Canvas edit. Mutating existing content requires baseRevision to prevent overwrites. Image replacement accepts only data URLs or authorized same-document penecho-ref references; arbitrary fetching is unavailable.", inputSchema:{type:"object",additionalProperties:false,required:["sessionId","requestId","action"],properties:{sessionId:{type:"string",minLength:1,maxLength:128},requestId:{type:"string",minLength:1,maxLength:128},action:{type:"string",enum:[...EDIT_ACTIONS]},objectId:{type:"string",minLength:1,maxLength:128},text:{type:"string",maxLength:MAX_FILE_BYTES},source:{type:"string",maxLength:MAX_FILE_BYTES},region:{type:"object",additionalProperties:false,required:["x","y","w","h"],properties:{x:{type:"number"},y:{type:"number"},w:{type:"number",exclusiveMinimum:0},h:{type:"number",exclusiveMinimum:0}}},width:{type:"number",exclusiveMinimum:0},height:{type:"number",exclusiveMinimum:0},baseRevision:{type:"integer",minimum:0}},allOf:[{if:{properties:{action:{const:"create_text"}},required:["action"]},then:{required:["text"]}},{if:{properties:{action:{const:"move"}},required:["action"]},then:{required:["objectId","region","baseRevision"]}},{if:{properties:{action:{const:"resize"}},required:["action"]},then:{required:["objectId","width","height","baseRevision"]}},{if:{properties:{action:{const:"delete"}},required:["action"]},then:{required:["objectId","baseRevision"]}},{if:{properties:{action:{const:"erase_ink"}},required:["action"]},then:{required:["region","baseRevision"]}},{if:{properties:{action:{const:"replace_image"}},required:["action"]},then:{required:["objectId","source","baseRevision"]}}]} },
  { name:"penecho_capture_canvas", description:"Explicitly capture bounded existing Canvas content from the visible session document. Targets include the viewport, Canvas, selection, region, or one object. This never shows a hidden document implicitly; CANVAS_NOT_VISIBLE includes retry guidance.", inputSchema:{type:"object",additionalProperties:false,required:["sessionId"],properties:{sessionId:{type:"string",minLength:1,maxLength:128},target:{type:"string",enum:[...CAPTURE_TARGETS],default:"viewport"},objectId:{type:"string",minLength:1,maxLength:128},region:{type:"object",additionalProperties:false,required:["x","y","w","h"],properties:{x:{type:"number"},y:{type:"number"},w:{type:"number",exclusiveMinimum:0},h:{type:"number",exclusiveMinimum:0}}},quality:{type:"string",enum:[...CAPTURE_QUALITIES],default:"basic"}},allOf:[{if:{properties:{target:{const:"object"}},required:["target"]},then:{required:["objectId"]}},{if:{properties:{target:{const:"region"}},required:["target"]},then:{required:["region"]}}]} },
  { name:"penecho_read_messages", description:"Pull bounded user messages for this session. Reading does not acknowledge receipt and never wakes a stopped client automatically.", inputSchema:{type:"object",additionalProperties:false,required:["sessionId"],properties:{sessionId:{type:"string",minLength:1,maxLength:128},after:{type:"integer",minimum:0,default:0},limit:{type:"integer",minimum:1,maximum:MAX_MESSAGES_PER_PAGE,default:20}}} },
  { name:"penecho_ack_messages", description:"Explicitly acknowledge pulled user message request IDs with a bounded processing status.", inputSchema:{type:"object",additionalProperties:false,required:["sessionId","ids","status"],properties:{sessionId:{type:"string",minLength:1,maxLength:128},ids:{type:"array",minItems:1,maxItems:MAX_REQUEST_IDS,uniqueItems:true,items:{type:"string",minLength:1,maxLength:128}},status:{type:"string",enum:[...MESSAGE_STATUSES]},message:{type:"string",maxLength:1000}}} },
  {
    name:"penecho_update_session",
    description:"Queue a bounded public progress update for a PenEcho session. Send concise findings, decisions, blockers and final status at natural work boundaries without delaying initial output. Batch related facts and reuse IDs; no periodic busywork, token streaming or screenshots for progress. The acknowledgement says queued; inspect_session reports whether the browser applied it and whether its surface was visible, without claiming pixel-level paint proof.",
    inputSchema:{ type:"object", additionalProperties:false, required:["sessionId"], properties:{ sessionId:{type:"string",minLength:1,maxLength:128}, title:{type:"string",minLength:1,maxLength:MAX_TITLE_CHARS}, status:{type:"string",enum:[...SESSION_STATUSES]}, summary:{type:"string",maxLength:MAX_SUMMARY_CHARS}, steps:{type:"array",maxItems:MAX_STEPS,items:{type:"object",additionalProperties:false,required:["id","label"],properties:{id:{type:"string",minLength:1,maxLength:64},label:{type:"string",minLength:1,maxLength:160},status:{type:"string",enum:[...STEP_STATUSES]}}}}, events:{type:"array",maxItems:MAX_EVENTS_PER_UPDATE,items:{type:"object",additionalProperties:false,required:["id","text"],properties:{id:{type:"string",minLength:1,maxLength:64},text:{type:"string",minLength:1,maxLength:500},kind:{type:"string",enum:[...EVENT_KINDS]}}}} } },
  },
  {
    name:"penecho_present_widget",
    description:"Present or inspect HTML in the exact PenEcho session. presentation expresses intent, hierarchy, preset viewport, stable relative placement, and attention. intent:inspect requires capture:true and returns one ephemeral pixel-verified render without creating a Canvas object. Other calls update the stable artifact; ordinary presentation stays screenshot-free. " + VISUAL_INSTRUCTIONS,
    inputSchema:{ type:"object", additionalProperties:false, required:["sessionId","artifactId","title","html"], properties:{sessionId:{type:"string",minLength:1,maxLength:128},artifactId:{type:"string",minLength:1,maxLength:128},title:{type:"string",minLength:1,maxLength:MAX_TITLE_CHARS},html:{type:"string",minLength:1,maxLength:MAX_HTML_CHARS},width:{type:"number",minimum:300,maximum:4096},height:{type:"number",minimum:200,maximum:4096},capture:{type:"boolean",default:false},quality:{type:"string",enum:["basic","detail"]},presentation:presentationSchema({allowInspect:true})}, allOf:[{if:{required:["quality"]},then:{required:["capture"],properties:{capture:{const:true}}}},{if:{properties:{presentation:{properties:{intent:{const:"inspect"}},required:["intent"]}},required:["presentation"]},then:{required:["capture"],properties:{capture:{const:true}}}},{if:{properties:{presentation:{required:["size"]}},required:["presentation"]},then:{not:{anyOf:[{required:["width"]},{required:["height"]}]}}}] },
  },
  {
    name:"penecho_capture_widget",
    description:"Capture one requested widget from the exact PenEcho session. No screenshot is taken unless this tool is called.",
    inputSchema:{ type:"object", additionalProperties:false, required:["sessionId","artifactId"], properties:{sessionId:{type:"string",minLength:1,maxLength:128},artifactId:{type:"string",minLength:1,maxLength:128},quality:{type:"string",enum:["basic","detail"]}} },
  },
  {
    name:"penecho_draw",
    description:"Create or replace a stable artifact with native Canvas text and rasterized shapes. presentation may express intent, role, relative placement, and attention; drawings use natural scene bounds and reject size or inspect. Rectangles and ellipses may include labels and have an 80 px minimum footprint. The result is saved with the Canvas and can be moved or resized; MCP can replace it by artifactId, but it has no editable vector handles and is not an iframe Widget. Set capture:true only when a bounded screenshot is needed. A capture error leaves the applied artifact in place, so retry with the same artifactId.",
    inputSchema:{ type:"object", additionalProperties:false, required:["sessionId","artifactId","title","items"], properties:{ sessionId:{type:"string",minLength:1,maxLength:128}, artifactId:{type:"string",minLength:1,maxLength:128}, title:{type:"string",minLength:1,maxLength:MAX_TITLE_CHARS}, items:{type:"array",minItems:1,maxItems:MAX_DRAW_ITEMS,items:{type:"object",additionalProperties:false,required:["id","type"],properties:{id:{type:"string",minLength:1,maxLength:64},type:{type:"string",enum:[...DRAW_TYPES]},text:{type:"string",minLength:1,maxLength:1_000},x:{type:"number",minimum:0,maximum:2_400},y:{type:"number",minimum:0,maximum:2_400},width:{type:"number",minimum:8,maximum:1_200},height:{type:"number",minimum:8,maximum:1_200},color:{type:"string",pattern:COLOR_PATTERN.source},fill:{type:"string",pattern:COLOR_PATTERN.source},fontSize:{type:"number",minimum:12,maximum:64},strokeWidth:{type:"number",minimum:1,maximum:12},points:{type:"array",minItems:2,maxItems:MAX_DRAW_POINTS,items:{type:"object",additionalProperties:false,required:["x","y"],properties:{x:{type:"number",minimum:0,maximum:2_400},y:{type:"number",minimum:0,maximum:2_400}}}},from:{type:"string",minLength:1,maxLength:64},to:{type:"string",minLength:1,maxLength:64}},allOf:[{if:{required:["type"],properties:{type:{enum:["rect","ellipse"]}}},then:{properties:{width:{minimum:80},height:{minimum:80}}}}]}}, capture:{type:"boolean",default:false}, presentation:presentationSchema({allowSize:false}) } },
  },
  {
    name:"penecho_plot",
    description:"Create or replace a stable native Canvas plot from a bounded mathematical expression. presentation may express intent, role, preset viewport, stable relative placement, and attention; inspect is reserved for Widgets. PenEcho compiles the expression safely without eval. The raster plot is saved with the Canvas and can be moved or resized; MCP can replace it by artifactId, but it has no editable vector handles and is not an iframe Widget. Set capture:true only when a bounded screenshot is needed. A capture error leaves the applied artifact in place, so retry with the same artifactId.",
    inputSchema:{ type:"object", additionalProperties:false, required:["sessionId","artifactId","title","expression"], properties:{sessionId:{type:"string",minLength:1,maxLength:128},artifactId:{type:"string",minLength:1,maxLength:128},title:{type:"string",minLength:1,maxLength:MAX_TITLE_CHARS},expression:{type:"string",minLength:1,maxLength:180},width:{type:"number",minimum:300,maximum:1_600},height:{type:"number",minimum:200,maximum:1_200},xMin:{type:"number",minimum:-1_000_000,maximum:1_000_000},xMax:{type:"number",minimum:-1_000_000,maximum:1_000_000},yMin:{type:"number",minimum:-1_000_000,maximum:1_000_000},yMax:{type:"number",minimum:-1_000_000,maximum:1_000_000},color:{type:"string",pattern:COLOR_PATTERN.source},capture:{type:"boolean",default:false},presentation:presentationSchema()}, allOf:[{if:{properties:{presentation:{required:["size"]}},required:["presentation"]},then:{not:{anyOf:[{required:["width"]},{required:["height"]}]}}}] },
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
  MAX_FILE_BYTES,
  McpBridgeError,
  TOOLS,
  validateToolArguments,
};
