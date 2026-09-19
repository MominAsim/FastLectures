"use strict";
const {SESSION_INSTRUCTIONS,VISUAL_INSTRUCTIONS,visualExplorerPrompt}=require("./guidance.js");
const PROTOCOL_VERSION = "2025-11-25";
const INSTRUCTIONS = require("./guidance.js").PUBLIC_INSTRUCTIONS;

const PROMPTS = [
  {name:"fastlectures_visual_explorer",description:"Author a clear spatial explanation using FastLectures’s shared Visual Explorer design standard.",arguments:[]},
  {name:"fastlectures_explain_selection",description:"Explain the currently selected FastLectures material in its document context.",arguments:[{name:"focus",description:"Optional explanation focus.",required:false}]},
  {name:"fastlectures_revise_feedback",description:"Read current FastLectures feedback and revise the bound document safely.",arguments:[{name:"goal",description:"Optional revision goal.",required:false}]},
  {name:"fastlectures_resume_document",description:"Resume work on a known persistent FastLectures document without changing the current view.",arguments:[{name:"documentId",description:"Persistent FastLectures document ID.",required:true}]},
];

function promptResult(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw Object.assign(new Error("Prompt arguments are invalid."), {code:-32602});
  const allowed = name === "fastlectures_explain_selection" ? new Set(["focus"]) : name === "fastlectures_revise_feedback" ? new Set(["goal"]) : name === "fastlectures_resume_document" ? new Set(["documentId"]) : new Set();
  if (Object.keys(args).some(key => !allowed.has(key))) throw Object.assign(new Error("Prompt arguments contain an unsupported field."), {code:-32602});
  for (const value of Object.values(args)) if (typeof value !== "string" || !value || value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)) throw Object.assign(new Error("Prompt argument is invalid."), {code:-32602});
  if (name === "fastlectures_visual_explorer") return {description:"FastLectures Visual Explorer design and workspace workflow",messages:[{role:"user",content:{type:"text",text:visualExplorerPrompt()}}]};
  if (name === "fastlectures_explain_selection") return {description:"Explain selected FastLectures material",messages:[{role:"user",content:{type:"text",text:`Use the exact opted-in FastLectures connection and attach with fastlectures_start_session target:"current" before reading the current selection; do not create or open another Canvas. Use a distinct stable attachment sessionKey if this conversation is already bound elsewhere. Explain the selected material${args.focus ? ` with this focus: ${args.focus}` : ""}. Keep the explanation public and concise.\n\n${VISUAL_INSTRUCTIONS}`}}]};
  if (name === "fastlectures_revise_feedback") return {description:"Revise from FastLectures feedback",messages:[{role:"user",content:{type:"text",text:`Read unread feedback for the bound FastLectures document, preserve independent cursors, and revise the stable artifact or virtual source${args.goal ? ` toward: ${args.goal}` : ""}. Read source before patching.\n\n${SESSION_INSTRUCTIONS}`}}]};
  if (name === "fastlectures_resume_document") {
    if (typeof args.documentId !== "string" || !args.documentId || args.documentId.length > 256) throw Object.assign(new Error("documentId is required."), {code:-32602});
    return {description:"Resume a persistent FastLectures document",messages:[{role:"user",content:{type:"text",text:`Find and resume FastLectures document ${args.documentId}. Keep show:false unless the user explicitly asks to change the visible document. Continue the primary task if the bridge is unavailable.\n\n${SESSION_INSTRUCTIONS}`}}]};
  }
  throw Object.assign(new Error("Prompt not found."), {code:-32602});
}

function captureToolResult(value) {
  if (!value?.image?.data || !value.image.mimeType) throw new Error("FastLectures returned an invalid widget capture.");
  const structuredContent = { ...value, image:{ mimeType:value.image.mimeType, bytes:value.image.bytes } };
  return {
    content:[
      { type:"image", data:value.image.data, mimeType:value.image.mimeType },
      { type:"text", text:JSON.stringify(structuredContent) },
    ],
    structuredContent,
  };
}

module.exports={PROTOCOL_VERSION,INSTRUCTIONS,PROMPTS,promptResult,captureToolResult};
