'use strict';
const fs=require('node:fs'),path=require('node:path');
function lanClientBundle(){
 const discovery=fs.readFileSync(path.join(__dirname,'lan-discovery.js'),'utf8');
 const client=fs.readFileSync(path.join(__dirname,'remote-client.js'),'utf8').replace(/^#![^\n]*\n/,'');
 return Buffer.from(`#!/usr/bin/env node\n'use strict';\nconst __nativeRequire=require;\nconst __discovery={exports:{}};\n(function(module,exports,require){\n${discovery}\n})(__discovery,__discovery.exports,__nativeRequire);\n(function(module,exports,require){\n${client}\n})(module,module.exports,Object.assign(function(id){return id==='./lan-discovery.js'?__discovery.exports:__nativeRequire(id);},{main:require.main}));\n`);
}
module.exports={lanClientBundle};
