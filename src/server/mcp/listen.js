"use strict";
const DEFAULT_MCP_PORTS = Object.freeze([3922, 13922, 23922]);
function listenMcp(server, preferredPort = DEFAULT_MCP_PORTS[0]) {
  const ports = preferredPort === DEFAULT_MCP_PORTS[0] ? [...DEFAULT_MCP_PORTS, 0] : preferredPort ? [preferredPort, 0] : [0];
  return new Promise((resolve, reject) => {
    let index = 0;
    const cleanup = () => { server.off('error', failed); server.off('listening', listening); };
    const listening = () => { cleanup(); resolve(); };
    const attempt = () => { try { server.listen(ports[index], '0.0.0.0'); } catch (error) { cleanup(); reject(error); } };
    const failed = error => {
      if (error.code === 'EADDRINUSE' && index + 1 < ports.length) { index++; attempt(); }
      else { cleanup(); reject(error); }
    };
    server.on('error', failed); server.once('listening', listening); attempt();
  });
}
module.exports = {DEFAULT_MCP_PORTS, listenMcp};
