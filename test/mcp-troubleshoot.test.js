"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const context=vm.createContext({URL});
vm.runInContext(fs.readFileSync(path.join(__dirname,"../src/client/app/mcp-troubleshoot.js"),"utf8"),context);
const {mcpTroubleshootPort:port,mcpWindowsFirewallCommand:command,mcpTroubleshootPrompt:prompt}=context;
const status=(value=51743)=>({enabled:true,hostPlatform:"win32",http:{enabled:true,localUrl:`https://127.0.0.1:${value}/mcp`,preferredUrl:"https://old.local:3922/mcp",accessToken:"SECRET"}});
test("actual fallback listener port wins over stale preferred URL",()=>{
  assert.equal(port(status()),51743);
  assert.match(command(status()),/\$port = 51743/);
  assert.match(command(status()),/-Direction Inbound -Action Allow -Protocol TCP -LocalPort \$port -Profile Private -RemoteAddress LocalSubnet/);
  assert.doesNotMatch(command(status()),/3922|SECRET|Set-NetFirewall|Disable-NetFirewall/);
  assert.match(command(status()),/Existing firewall rule differs/);
  assert.match(command(status()),/if \(\$rules.Count -gt 0\)/);
});
test("missing disabled and invalid service cannot generate commands",()=>{
  for(const value of [null,{}, {enabled:false,http:status().http},{http:{enabled:false,localUrl:status().http.localUrl}},{http:{enabled:true,preferredUrl:"https://host:3922/mcp"}}, ...[0,-1,65536,"wat"].map(status)]) {
    assert.equal(port(value),null);assert.equal(command(value),"");assert.equal(prompt(value),"");
  }
  for(const localUrl of ["http://127.0.0.1:1234/mcp","https://other:1234/mcp","https://127.0.0.1:1234/","https://token@127.0.0.1:1234/mcp","https://127.0.0.1:1234/mcp?secret=x"]){assert.equal(port({http:{enabled:true,localUrl}}),null);}
});
test("HTTPS default and maximum valid ports are supported",()=>{assert.equal(port(status(443)),443);assert.equal(port(status(65535)),65535);});
test("prompt uses host platform and contains no host credentials",()=>{
  const value=status();value.hostPlatform="darwin";
  assert.match(prompt(value),/Host platform: darwin/);
  assert.match(prompt(value),/browser's operating system does not identify/);
  assert.match(prompt(value),/TCP port 51743/);
  assert.doesNotMatch(prompt(value),/SECRET|3922/);
  delete value.hostPlatform;assert.match(prompt(value),/Host platform: unknown/);
});

test("listener gate runs before firewall changes and rollback is only printed for creation",()=>{
  const script=command(status());
  assert.match(script,/Get-NetTCPConnection -State Listen -LocalPort \$port/);
  assert.match(script,/if \(\$listeners.Count -eq 0\) \{ throw/);
  assert.ok(script.indexOf("$listeners.Count -eq 0") < script.indexOf("New-NetFirewallRule"));
  assert.match(script,/\$created = \$false/);
  assert.match(script,/Out-Null\n  \$created = \$true/);
  assert.match(script,/if \(\$created\) \{ Write-Output .*Remove-NetFirewallRule -PolicyStore PersistentStore -Name '\$name'/);
  assert.doesNotMatch(script,/^\s*Remove-NetFirewallRule/m);
  assert.match(prompt(status()),/mDNS UDP 5353 only if direct HTTPS works but discovery fails/);
  assert.match(prompt(status()),/do not remove a pre-existing rule/);
});
