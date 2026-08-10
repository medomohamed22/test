const { send, allowMethods, body, requireUser, sb } = require('./_lib');
const crypto = require('crypto');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const APP_URL = (process.env.APP_URL || '').replace(/\/$/,'');
const STATE_SECRET = process.env.GOOGLE_OAUTH_STATE_SECRET || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

function b64u(buf){return Buffer.from(buf).toString('base64url')}
function signState(payload){
  const raw=b64u(JSON.stringify(payload));
  const sig=crypto.createHmac('sha256',STATE_SECRET).update(raw).digest('base64url');
  return `${raw}.${sig}`;
}
function verifyState(state){
  const [raw,sig]=String(state||'').split('.');
  if(!raw||!sig)throw new Error('invalid_state');
  const expected=crypto.createHmac('sha256',STATE_SECRET).update(raw).digest('base64url');
  if(!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))throw new Error('invalid_state');
  const p=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));
  if(!p.exp||Date.now()>p.exp)throw new Error('expired_state');
  return p;
}
async function googleToken(data){
  const res=await fetch('https://oauth2.googleapis.com/token',{
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams(data)
  });
  const txt=await res.text();let out={};try{out=JSON.parse(txt)}catch{}
  if(!res.ok){const e=new Error(out.error||'google_token_failed');e.detail=out;throw e}
  return out;
}
function encrypt(text){
  if(!text)return null;
  const key=crypto.createHash('sha256').update(STATE_SECRET).digest();
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  const enc=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);
  const tag=cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}
function decrypt(blob){
  if(!blob)return '';
  const [iv,tag,enc]=String(blob).split('.');
  const key=crypto.createHash('sha256').update(STATE_SECRET).digest();
  const d=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64url'));
  d.setAuthTag(Buffer.from(tag,'base64url'));
  return Buffer.concat([d.update(Buffer.from(enc,'base64url')),d.final()]).toString('utf8');
}

async function tokenRow(userId){
  const rows=await sb(`google_drive_tokens?user_id=eq.${encodeURIComponent(userId)}&select=*&limit=1`);
  return rows?.[0]||null;
}
async function accessToken(userId){
  let row=await tokenRow(userId);
  if(!row)throw new Error('google_not_connected');
  if(row.access_token_enc && row.expires_at && Date.parse(row.expires_at)>Date.now()+60000){
    return decrypt(row.access_token_enc);
  }
  const refresh=decrypt(row.refresh_token_enc);
  if(!refresh)throw new Error('google_reconnect_required');
  const t=await googleToken({client_id:CLIENT_ID,client_secret:CLIENT_SECRET,refresh_token:refresh,grant_type:'refresh_token'});
  const expiresAt=new Date(Date.now()+Number(t.expires_in||3600)*1000).toISOString();
  await sb(`google_drive_tokens?user_id=eq.${encodeURIComponent(userId)}`,{
    method:'PATCH',
    data:{access_token_enc:encrypt(t.access_token),expires_at:expiresAt,updated_at:new Date().toISOString()},
    headers:{Prefer:'return=minimal'}
  });
  return t.access_token;
}
async function driveFetch(userId,url,options={}){
  const tok=await accessToken(userId);
  const r=await fetch(url,{...options,headers:{Authorization:`Bearer ${tok}`,...(options.headers||{})}});
  if(!r.ok){const tx=await r.text().catch(()=> '');const e=new Error('drive_http_'+r.status);e.detail=tx;throw e}
  return r;
}
function qEsc(s){return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'")}
async function folderId(userId){
  const q=`name='ChatWay Backups' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  let r=await driveFetch(userId,'https://www.googleapis.com/drive/v3/files?spaces=drive&pageSize=10&fields=files(id,name)&q='+encodeURIComponent(q));
  let d=await r.json();if(d.files?.[0])return d.files[0].id;
  r=await driveFetch(userId,'https://www.googleapis.com/drive/v3/files?fields=id',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'ChatWay Backups',mimeType:'application/vnd.google-apps.folder'})});
  return (await r.json()).id;
}
async function listBackups(userId,folder=null){
  folder=folder||await folderId(userId);
  const q=`'${qEsc(folder)}' in parents and name contains 'chatway-backup-' and trashed=false`;
  const r=await driveFetch(userId,'https://www.googleapis.com/drive/v3/files?spaces=drive&pageSize=20&orderBy=modifiedTime%20desc&fields=files(id,name,modifiedTime,size)&q='+encodeURIComponent(q));
  return {folder,files:(await r.json()).files||[]};
}

module.exports = async function handler(req,res){
  if(!allowMethods(req,res,['GET','POST','DELETE']))return;
  try{
    if(!CLIENT_ID||!CLIENT_SECRET||!APP_URL||!STATE_SECRET)throw new Error('google_oauth_not_configured');

    // OAuth callback is intentionally unauthenticated; signed state binds it to the Pi user.
    if(req.method==='GET' && req.query?.code){
      const st=verifyState(req.query.state);
      const redirectUri=`${APP_URL}/api/google`;
      const t=await googleToken({
        code:String(req.query.code),
        client_id:CLIENT_ID,
        client_secret:CLIENT_SECRET,
        redirect_uri:redirectUri,
        grant_type:'authorization_code'
      });
      const old=await tokenRow(st.userId);
      const refresh=t.refresh_token || (old?.refresh_token_enc?decrypt(old.refresh_token_enc):'');
      await sb('google_drive_tokens?on_conflict=user_id',{
        method:'POST',
        data:[{
          user_id:st.userId,
          refresh_token_enc:encrypt(refresh),
          access_token_enc:encrypt(t.access_token||''),
          expires_at:new Date(Date.now()+Number(t.expires_in||3600)*1000).toISOString(),
          updated_at:new Date().toISOString()
        }],
        headers:{Prefer:'resolution=merge-duplicates,return=minimal'}
      });
      res.statusCode=302;
      res.setHeader('Location',`${APP_URL}/google-connect.html?connected=1`);
      return res.end();
    }

    const me=requireUser(req);

    if(req.method==='GET'){
      const row=await tokenRow(me.sub);
      return send(res,200,{connected:!!row});
    }

    if(req.method==='DELETE'){
      await sb(`google_drive_tokens?user_id=eq.${encodeURIComponent(me.sub)}`,{method:'DELETE'});
      return send(res,200,{ok:true});
    }

    const b=body(req),action=String(b.action||'');

    if(action==='auth_url'){
      const redirectUri=`${APP_URL}/api/google`;
      const state=signState({userId:me.sub,exp:Date.now()+10*60*1000,nonce:crypto.randomBytes(10).toString('hex')});
      const u=new URL('https://accounts.google.com/o/oauth2/v2/auth');
      u.searchParams.set('client_id',CLIENT_ID);
      u.searchParams.set('redirect_uri',redirectUri);
      u.searchParams.set('response_type','code');
      u.searchParams.set('scope',SCOPE);
      u.searchParams.set('access_type','offline');
      u.searchParams.set('include_granted_scopes','true');
      u.searchParams.set('prompt','consent');
      u.searchParams.set('state',state);
      return send(res,200,{url:u.toString()});
    }

    if(action==='backup'){
      const data=b.backup;
      if(!data||data.format!=='chatway-backup')return send(res,400,{error:'invalid_backup'});
      const folder=await folderId(me.sub);
      const name='chatway-backup-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';
      const metadata={name,parents:[folder],mimeType:'application/json',appProperties:{app:'ChatWay',kind:'backup'}};
      const boundary='cw'+crypto.randomBytes(8).toString('hex');
      const multipart=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data)}\r\n--${boundary}--`;
      await driveFetch(me.sub,'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime',{
        method:'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body:multipart
      });
      const allb=await listBackups(me.sub,folder);
      for(const old of allb.files.slice(5)){
        driveFetch(me.sub,'https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(old.id),{method:'DELETE'}).catch(()=>{});
      }
      return send(res,200,{ok:true});
    }

    if(action==='restore_latest'){
      const {files}=await listBackups(me.sub);
      if(!files.length)return send(res,404,{error:'no_backup'});
      const newest=files[0];
      const r=await driveFetch(me.sub,'https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(newest.id)+'?alt=media');
      const backup=await r.json();
      return send(res,200,{ok:true,backup,modifiedTime:newest.modifiedTime,name:newest.name});
    }

    return send(res,400,{error:'invalid_action'});
  }catch(e){
    console.error('google api',e,e.detail||'');
    send(res,e.message==='google_not_connected'?401:(e.status||500),{error:e.message,detail:e.detail||undefined});
  }
};
