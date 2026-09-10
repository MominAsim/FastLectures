"use strict";
const crypto = require('node:crypto');
function der(tag, ...parts) {
  const value = Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p)));
  let n = value.length, bytes = [];
  while (n) { bytes.unshift(n & 255); n >>>= 8; }
  return Buffer.concat([Buffer.from([tag, ...(value.length < 128 ? [value.length] : [128 | bytes.length, ...bytes])]), value]);
}
const seq = (...v) => der(0x30, ...v);
const oid = hex => der(6, Buffer.from(hex, 'hex'));
function createLanCertificate(addresses = []) {
  const {privateKey, publicKey} = crypto.generateKeyPairSync('ec', {namedCurve:'prime256v1'});
  const algorithm = seq(oid('2a8648ce3d040302'));
  const name = seq(der(0x31, seq(oid('550403'), der(12, 'PenEcho LAN MCP'))));
  const date = value => der(0x18, value.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'));
  const serial = crypto.randomBytes(16); serial[0] &= 0x7f; serial[0] |= 1;
  const tbs = seq(der(0xa0, der(2, [2])), der(2, serial), algorithm, name,
    seq(date(new Date(Date.now() - 86400000)), date(new Date(Date.now() + 36525 * 86400000))), name,
    publicKey.export({format:'der',type:'spki'}),
    ...(addresses.length ? [der(0xa3, seq(seq(oid('551d11'), der(4, seq(...addresses.map(address => der(0x87, address.split('.').map(Number))))))))] : []));
  const raw = seq(tbs, algorithm, der(3, [0], crypto.sign('sha256', tbs, privateKey)));
  const cert = `-----BEGIN CERTIFICATE-----\n${raw.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  return {key:privateKey.export({format:'pem',type:'pkcs8'}), cert, fingerprint:crypto.createHash('sha256').update(raw).digest('hex')};
}
module.exports = {createLanCertificate};
