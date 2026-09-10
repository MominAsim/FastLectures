'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {createLanCertificate}=require('./lan-certificate.js');
function validateIdentity(value) {
  if(!value || !/^[a-f0-9]{64}$/.test(value.invitation) || !/^[a-f0-9]{64}$/.test(value.fingerprint))throw new Error('Invalid LAN identity');
  const cert=new crypto.X509Certificate(value.cert),key=crypto.createPrivateKey(value.key);
  if(!cert.checkPrivateKey(key)||!cert.verify(cert.publicKey)||crypto.createHash('sha256').update(cert.raw).digest('hex')!==value.fingerprint)throw new Error('Invalid LAN identity');
  return {key:value.key,cert:value.cert,fingerprint:value.fingerprint,invitation:value.invitation};
}
function identityStore(directory,{platform=process.platform}={}) {
  const file=directory && path.join(directory,'lan-identity.json');
  function load() {
    if(!file)return null;
    try {const stat=fs.lstatSync(file);if(!stat.isFile()||stat.size>32768)throw new Error('Invalid LAN identity file');const value=validateIdentity(JSON.parse(fs.readFileSync(file,'utf8')));fs.chmodSync(directory,0o700);fs.chmodSync(file,0o600);return value;}catch(e){if(e.code==='ENOENT')return null;throw e;}
  }
  function create() {
    const value=validateIdentity({...createLanCertificate(),invitation:crypto.randomBytes(32).toString('hex')});
    if(file) {
      fs.mkdirSync(directory,{recursive:true,mode:0o700});fs.chmodSync(directory,0o700);
      const temp=path.join(directory,`.lan-identity-${crypto.randomUUID()}.tmp`);let fd;
      try {fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,file);if(platform!=='win32'){const dir=fs.openSync(directory,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}}
      finally {if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}}
    }
    return value;
  }
  return {load,create};
}
module.exports={identityStore,validateIdentity};
