  // Pure helpers: status comes from the PenEcho host, never browser OS or cached setup URLs.
  function mcpTroubleshootPort(status) {
    if (!status || status.enabled === false || status.http?.enabled !== true) return null;
    try {
      const endpoint = new URL(status.http.localUrl);
      if (endpoint.protocol !== "https:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/mcp" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return null;
      const port = endpoint.port ? Number(endpoint.port) : 443;
      return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
    } catch { return null; }
  }

  function mcpWindowsFirewallCommand(status) {
    const port = mcpTroubleshootPort(status);
    if (port === null) return "";
    return `$ErrorActionPreference = 'Stop'
$port = ${port}
$name = 'PenEcho-MCP-Private-LocalSubnet-TCP-${port}'
$description = 'PenEcho MCP inbound HTTPS; Private LocalSubnet only; v1'
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
if ($listeners.Count -eq 0) { throw 'No TCP listener on the copied MCP port. Refresh PenEcho MCP status and copy a new command before changing the firewall.' }
$created = $false
$rules = @(Get-NetFirewallRule -PolicyStore PersistentStore -ErrorAction Stop | Where-Object { $_.Name -eq $name })
if ($rules.Count -gt 0) {
  if ($rules.Count -ne 1) { throw 'Firewall rule name collision; no changes made.' }
  $rule = $rules[0]
  $ports = @($rule | Get-NetFirewallPortFilter)
  $addresses = @($rule | Get-NetFirewallAddressFilter)
  if ($rule.Description -ne $description -or $rule.Direction -ne 'Inbound' -or $rule.Action -ne 'Allow' -or $rule.Enabled -ne 'True' -or [string]$rule.Profile -ne 'Private' -or $ports.Count -ne 1 -or [string]$ports[0].Protocol -notin @('TCP', '6') -or [string]$ports[0].LocalPort -ne [string]$port -or [string]$ports[0].RemotePort -ne 'Any' -or $addresses.Count -ne 1 -or [string]$addresses[0].RemoteAddress -ne 'LocalSubnet' -or [string]$addresses[0].LocalAddress -ne 'Any') {
    throw 'Existing firewall rule differs from the requested scoped rule; inspect it manually. No changes made.'
  }
} else {
  New-NetFirewallRule -PolicyStore PersistentStore -Name $name -DisplayName $name -Description $description -Enabled True -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -Profile Private -RemoteAddress LocalSubnet | Out-Null
  $created = $true
}
Get-NetFirewallRule -PolicyStore ActiveStore -Name $name | Format-Table Name, Enabled, Direction, Action, Profile
if ($created) { Write-Output "Created this rule. To roll back only this newly created rule: Remove-NetFirewallRule -PolicyStore PersistentStore -Name '$name'" }`;
  }

  function mcpTroubleshootPrompt(status) {
    const command = mcpWindowsFirewallCommand(status);
    if (!command) return "";
    const port = mcpTroubleshootPort(status);
    const hostPlatform = ["win32", "darwin", "linux"].includes(status.hostPlatform) ? status.hostPlatform : "unknown";
    return `Diagnose PenEcho direct HTTPS MCP connectivity. The latest host status reports TCP port ${port}; this is the running listener port, not a configured default. Host platform: ${hostPlatform}. The browser's operating system does not identify the computer running PenEcho. Confirm the target host and refresh its MCP status before changing rules; regenerate the command if its listener port changed. Check the listener and network reachability first. If the PenEcho host is Windows and inbound firewall access is the cause, run the following in elevated PowerShell on that host. It allows only inbound TCP ${port} on Private networks from LocalSubnet, leaves existing mismatched rules untouched, and does not disable the firewall. Do not change a Public network to Private automatically. Verify the resulting effective rule and test HTTPS reachability from the client without disabling TLS verification; report the observed result. Check mDNS UDP 5353 only if direct HTTPS works but discovery fails; do not open UDP as part of the HTTPS firewall fix. If the script reports that it created a new rule, its output includes the exact Remove-NetFirewallRule rollback command for that rule only; do not remove a pre-existing rule. Never include access tokens or private keys in output.\n\n${command}`;
  }
