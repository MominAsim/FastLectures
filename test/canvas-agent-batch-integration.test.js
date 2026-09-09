const test=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs'),os=require('node:os'),path=require('node:path')

test('Harness executes concurrent reads then revision-guarded writes in one model decision',async t=>{
  const {CanvasHarnessHost}=await import('../src/server/canvas-agent/runtime.mjs')
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'penecho-batch-integration-'))
  const connection={id:'batch',provider:'claude-cli',name:'Batch fixture',cliPath:'unused-test-cli',cliModel:'test-model',effort:'medium'}
  let requests=0,session,resolveEnd,rejectEnd,readOverlap=0
  const finished=new Promise((resolve,reject)=>{resolveEnd=resolve;rejectEnd=reject}),browser=[],pendingReads=[]
  const host=new CanvasHarnessHost({stateDirectory:directory,rootDirectory:path.resolve(__dirname,'..'),
    resolveConnection:()=>connection,listConnections:()=>[connection],
    callCli:async()=>{
      requests++
      if(requests===1)return JSON.stringify({type:'tool_calls',calls:[
        {name:'canvas_read',arguments:{objectId:'a'}},
        {name:'canvas_read',arguments:{objectId:'b'}},
        {name:'canvas_edit',arguments:{baseRevision:10,operations:[{type:'update_text',objectId:'a',text:'A'}]}},
        {name:'canvas_edit',arguments:{baseRevision:10,operations:[{type:'update_text',objectId:'b',text:'B'}]}},
      ]})
      assert.equal(requests,2,'no protocol-repair or per-tool model round may be inserted')
      return JSON.stringify({type:'final',text:'Updated both.'})
    }})
  t.after(async()=>{await host.dispose();fs.rmSync(directory,{recursive:true,force:true})})
  const timeout=setTimeout(()=>rejectEnd(Error(`Batch did not complete: requests=${requests}, browser=${JSON.stringify(browser.map(call=>({name:call.name,args:call.arguments})))}`)),5000)
  t.after(()=>clearTimeout(timeout))
  session=await host.connect({clientId:'batch-fixture',connectionId:'batch',binding:{},send(type,payload){
    if(type==='session_event'&&payload.kind==='turn_end')resolveEnd()
    if(type!=='tool_request')return
    browser.push(payload)
    if(payload.name==='canvas_read'){
      pendingReads.push(payload);readOverlap=Math.max(readOverlap,pendingReads.length)
      if(pendingReads.length===2)setImmediate(()=>{
        for(const read of pendingReads.splice(0))host.resolveToolResult(session,{requestId:read.requestId,ok:true,result:{revision:10,text:'Original'}})
      })
    }else setImmediate(()=>{
      const expected=browser.filter(call=>call.name==='canvas_edit').length+9
      try{assert.equal(payload.arguments.baseRevision,expected)}catch(error){rejectEnd(error)}
      host.resolveToolResult(session,{requestId:payload.requestId,ok:true,result:{ok:true,previousRevision:expected,revision:expected+1}})
    })
  }})
  host.updateState(session,{revision:10,canvas:{width:2048,height:2048},objects:[]})
  await host.submit(session,'Read and update the two existing text objects.')
  await finished
  assert.equal(requests,2);assert.equal(readOverlap,2)
  assert.deepEqual(browser.map(call=>call.name),['canvas_read','canvas_read','canvas_edit','canvas_edit'])
  assert.deepEqual(browser.filter(call=>call.name==='canvas_edit').map(call=>call.arguments.baseRevision),[10,11])
})
