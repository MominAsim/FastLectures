import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { TOOLS, validateToolArguments } = require('../mcp/schema.js')
const { executeBoundCanvasTool, BOUND_CANVAS_TOOL_NAMES } = require('../mcp/bound-operations.js')
const { getAuthoringGuidance, ROUTING } = require('../mcp/authoring-guidance.js')

// JSON Schema constraints not represented by Harness's SDK remain enforced by
// the SAME MCP validator, rather than being reimplemented in a second dialect.
const schemaKeys = new Set(['type','properties','required','additionalProperties','items','enum','const','oneOf','description','title','default','examples'])
export function harnessDocumentSchema(schema) {
  if (Array.isArray(schema)) return schema.map(harnessDocumentSchema)
  if (!schema || typeof schema !== 'object') return schema
  return Object.fromEntries(Object.entries(schema).filter(([key])=>schemaKeys.has(key)).map(([key,value])=>[
    key,key==='properties'?Object.fromEntries(Object.entries(value).map(([name,item])=>[name,harnessDocumentSchema(item)])):
      ['enum','required','examples','default'].includes(key)?value:harnessDocumentSchema(value),
  ]))
}

export function documentSessionId(session) {
  return `agent-${createHash('sha256').update(String(session.logicalConversationId || session.id)).digest('hex')}`
}

export function validateDocumentToolArguments(name, input, session) {
  if (!name.startsWith('penecho_')) return
  if(name==='penecho_get_guidance')return validateToolArguments(name,input)
  const id=documentSessionId(session)
  if(input?.sessionId!==undefined&&input.sessionId!==id)throw Object.assign(new Error('Omit sessionId; the host binds the current Canvas.'),{code:'SESSION_SCOPE_MISMATCH'})
  if(name==='penecho_upload_image' && input?.attachmentId!==undefined) {
    if(input.source!==undefined)throw new Error('Supply source or attachmentId, not both.')
    if(typeof input.attachmentId!=='string'||!session.attachmentRefs?.has(input.attachmentId))throw Object.assign(new Error('Image attachment is not owned by this PenEcho Agent session.'),{code:'ATTACHMENT_SCOPE_MISMATCH'})
    const {attachmentId,...rest}=input
    return validateToolArguments(name,{...rest,source:'penecho-asset:'+'0'.repeat(64),sessionId:id})
  }
  return validateToolArguments(name,{...input,sessionId:id})
}

export const DOCUMENT_TOOL_INSTRUCTIONS = `The current Canvas is already bound by the host. Use the penecho_* document tools; omit sessionId (the host supplies it). Do not discover, open, or switch documents to perform this task.
Read canvas.json for the current revision and objects/index.json or penecho_list_files for exact virtual paths. Read source with penecho_read_file and patch its exact path using contentHash and requestId. SOURCE_CONFLICT needs a fresh read and new requestId; an uncertain outcome needs identical arguments and the same requestId. Runtime files are observations, not editable source. Keep source edits separate from geometry.
Save image attachments with penecho_upload_image (source or a session-owned attachmentId), then use its returned source directly in Widget HTML img src or CSS url(), penecho_place_image, or replace_image. Upload does not place an object; placement uses automatic layout unless region is supplied. Create HTML with penecho_present_widget, simple native marks with penecho_draw, functions with penecho_plot. Automatic/relative placement belongs to the host. relativeTo must be a known artifactId in this session, never an objectId or guessed title; omit it for independent work. Use penecho_edit_canvas with action:"draw_ink" with world coordinates for annotation over handwriting. Keep artifactId stable. Combine present and capture:true when pixel evidence is needed; do not add routine inspect/capture rounds. A capture failure may leave content applied: inspect and reuse the artifact, never create a duplicate.
Finish once the requested answer is complete, readable and usable. Continue only for material errors, missing requirements or broken interaction; optional cosmetic polish does not justify more read/patch/capture cycles.
For UI pages preserve the requested product's actual layout, background and interaction; do not turn them into explanatory infographics. Use penecho_get_guidance only for the relevant authoring path. Professional Diagram and private plugin authoring/editing are unavailable. Existing saved content remains visible.
${ROUTING || ''}`

export function createDocumentTools(session, { wrap, output, saveImage, readImage, onGuidance } = {}) {
  const names = new Set(BOUND_CANVAS_TOOL_NAMES)
  const boundId = documentSessionId(session)
  const bound = session.documentToolSession ||= { id:boundId, connection:null, mutationRequests:new Map(), title:'PenEcho Agent', status:'working', steps:[], events:[] }
  return TOOLS.filter(tool=>names.has(tool.name)||tool.name==='penecho_get_guidance').map(definition=>{
    const schema=structuredClone(definition.inputSchema)
    if (schema.properties.sessionId) schema.required=(schema.required||[]).filter(key=>key!=='sessionId')
    if(definition.name==='penecho_upload_image') {
      schema.required=schema.required.filter(key=>key!=='source')
      schema.properties.attachmentId={type:'string',description:'Instead of source, use an image attachmentId from this session host references. Never supply a host path.'}
      schema.oneOf=[{required:['source']},{required:['attachmentId']}]
    }
    const tool={
      name:definition.name, description:definition.description, parameters:harnessDocumentSchema(schema),
      output, timeoutMs:45_000,
      isConcurrencySafe:()=>false,
      async execute(input, exec) {
        if (definition.name==='penecho_get_guidance') {
          const args=validateToolArguments(definition.name,input),guidance=getAuthoringGuidance(args.id)
          onGuidance?.(guidance)
          return guidance
        }
        if (input?.sessionId!==undefined && input.sessionId!==boundId) throw Object.assign(new Error('This tool is bound to the current Canvas conversation. Omit sessionId.'),{code:'SESSION_SCOPE_MISMATCH'})
        validateDocumentToolArguments(definition.name,input,session)
        let args={...input,sessionId:boundId}
        if(definition.name==='penecho_upload_image' && args.attachmentId!==undefined) {
          const ref=session.attachmentRefs.get(args.attachmentId)
          if(typeof readImage!=='function')throw new Error('Image attachment reader is unavailable.')
          const stored=await readImage(ref,exec.signal)
          args.source=`data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`
          delete args.attachmentId
          args=validateToolArguments(definition.name,args)
        }
        let sequence=0
        const canvasCall=async (_connection,operation,arguments_)=>{
          const requestedAt=Date.now()
          const result=await session.rpc('canvas_document',{operation,arguments:arguments_,bindingKey:boundId},`${exec.callId}:${++sequence}`,exec.signal)
          return {result,timing:{requestedAt,completedAt:Date.now(),durationMs:Date.now()-requestedAt}}
        }
        const result=await executeBoundCanvasTool({name:definition.name,args,session:bound,canvasCall,callOptions:{signal:exec.signal}})
        if (!result.image) return result
        const {image,...metadata}=result
        const attachment=await saveImage(image,exec)
        return {...metadata,attachment}
      },
    }
    if (wrap) tool.execute=wrap(tool.name,tool.execute)
    return tool
  })
}
