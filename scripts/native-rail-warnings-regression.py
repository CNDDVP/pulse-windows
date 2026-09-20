import base64, json, os, socket, subprocess, tempfile, time, urllib.request, ctypes
from ctypes import wintypes
from pathlib import Path
import websocket

root=Path(__file__).resolve().parent.parent/'release-artifacts'
data=Path(tempfile.mkdtemp(prefix='pulse-rail-warnings-'))
(data/'settings.json').write_text(json.dumps({
 'schema_version':4,'dock_side':'left','auto_collapse_seconds':1,
 'monitoring_setup_completed':True,'authorized_providers':[],
 'token_spend_enabled':False,'hide_fullscreen':False,
 'providers':{'fixture':{'provider_id':'codex','label':'Regression fixture','enabled':True,'use_local':False}},
}),encoding='utf-8')
with socket.socket() as sock:
 sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
env=os.environ.copy();env['PULSE_DATA_DIR']=str(data)
env['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS']=f'--remote-debugging-port={port} --remote-allow-origins=http://localhost'
proc=subprocess.Popen([str(root/'pulse-v048-rail-warnings.exe')],env=env,creationflags=subprocess.CREATE_NO_WINDOW)
connections=[]
try:
 pages=[]
 for _ in range(100):
  if proc.poll() is not None: raise RuntimeError(f'Process exited {proc.returncode}')
  try:
   pages=json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json/list',timeout=1))
   if len(pages)>=3:break
  except Exception:pass
  time.sleep(.1)
 def evaluate(ws,expression):
  ws.send(json.dumps({'id':1,'method':'Runtime.evaluate','params':{'expression':expression,'awaitPromise':True,'returnByValue':True}}))
  while True:
   response=json.loads(ws.recv())
   if response.get('id')==1:
    if 'exceptionDetails' in response.get('result',{}):raise RuntimeError(response['result']['exceptionDetails'])
    return response.get('result',{}).get('result',{}).get('value')
 tabs={}
 for page in pages:
  if page.get('type')!='page':continue
  ws=websocket.create_connection(page['webSocketDebuggerUrl'],origin='http://localhost',timeout=10);connections.append(ws)
  label=None
  for _ in range(50):
   label=evaluate(ws,'window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label')
   if label:break
   time.sleep(.1)
  if label:tabs[label]=ws
 assert 'main' in tabs and 'detail' in tabs, list(tabs)
 main,detail=tabs['main'],tabs['detail']
 def invoke(ws,name,args=None):return evaluate(ws,f'window.__TAURI_INTERNALS__.invoke({json.dumps(name)}, {json.dumps(args or {})})')
 settings_tab=tabs['settings']
 invoke(main,'open_settings');time.sleep(.3)
 evaluate(settings_tab,"[...document.querySelectorAll('button')].find(x=>x.textContent.includes('通用设置'))?.click()")
 time.sleep(.4)
 assert evaluate(settings_tab,"document.body.innerText.includes('收纳条颜色与预警')")
 timestamp=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
 reading={'account_id':'fixture','provider_id':'codex','display_name':'Regression fixture','state':'live','primary_percent':97,
  'last_success_at':timestamp,'checked_at':timestamp,'source':'fixture','is_active':False,'plan_name':None,'error_code':None,'error_message':None,
  'retry_after_seconds':None,'duration_ms':None,'balances':[],
  'windows':[{'id':'five','name':'5h','used_percent':97,'used_fraction':.97,'window_seconds':3600,'resets_at':None,'exhausted':False}]}
 # Fixture injection invokes only this test WebView's registered reading callbacks.
 # No event-emission ACL is granted, and no backend provider/account is contacted.
 def inject():
  for tab in [main,settings_tab]:
   count=evaluate(tab,"(()=>{let n=0;const payload="+json.dumps([reading])+";for(const name of Object.getOwnPropertyNames(window)){const value=Object.getOwnPropertyDescriptor(window,name)?.value;if(value&&typeof value==='object'&&Object.hasOwn(value,'usages-updated')){const listeners=value['usages-updated'];for(const id of Object.getOwnPropertyNames(listeners)){window.__TAURI_INTERNALS__.runCallback(listeners[id].handlerId,{event:'usages-updated',id:Number(id),payload});n++}}}return n})()")
   assert count>0, 'reading callback not registered'
  time.sleep(.3)
 inject()
 def bar():return evaluate(main,"(()=>{const e=document.querySelector('[aria-label=\"展开 Pulse\"]');return {cls:e.className,title:e.title,color:getComputedStyle(e).backgroundColor}})()")
 assert 'rail-glow-red' in bar()['cls'],bar()
 baseline=invoke(main,'get_settings')
 changed=json.loads(json.dumps(baseline));changed['rail_warnings']['custom_thresholds']=True;changed['rail_warnings']['yellow']=98;changed['rail_warnings']['red']=99
 invoke(main,'update_settings',{'newSettings':changed});time.sleep(.1);inject()
 assert 'rail-glow-emerald' in bar()['cls'],bar()
 assert evaluate(settings_tab,"document.body.innerText.includes('目标颜色：绿色')")
 assert evaluate(settings_tab,"document.body.innerText.includes('实际收纳条：绿色')")
 evaluate(settings_tab,"document.querySelector('[aria-label=\"收纳条颜色模式\"]').closest('section')?.scrollIntoView({block:'start'})")
 settings_tab.send(json.dumps({'id':2,'method':'Page.captureScreenshot','params':{'format':'png'}}))
 while True:
  shot=json.loads(settings_tab.recv())
  if shot.get('id')==2:
   if 'data' in shot.get('result',{}):(root/'rail-warning-settings.png').write_bytes(base64.b64decode(shot['result']['data']))
   break

 invalid=invoke(main,'get_settings');invalid['rail_warnings']['yellow']=100
 rejected=False
 try:invoke(main,'update_settings',{'newSettings':invalid})
 except RuntimeError:rejected=True
 assert rejected and invoke(main,'get_settings')['rail_warnings']['yellow']==98
 changed=invoke(main,'get_settings');changed['rail_warnings']['scope']='selected';changed['rail_warnings']['account_ids']=[]
 invoke(main,'update_settings',{'newSettings':changed});time.sleep(.1);inject()
 assert 'rail-glow-zinc' in bar()['cls'],bar()
 disk=json.loads((data/'settings.json').read_text(encoding='utf-8'))
 assert disk['rail_warnings']['scope']=='selected' and disk['rail_warnings']['account_ids']==[]
 result={'red_from_97_percent':True,'manual_threshold_live_sync':True,'preview_matches_rail':True,'invalid_save_keeps_settings':True,'empty_selection_grey':True,'persisted_settings':disk['rail_warnings']}
 print(json.dumps(result),flush=True)
 (root/'rail-warnings-native-result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')

finally:
 for ws in connections:ws.close()
 if proc.poll() is None:subprocess.run(['taskkill','/PID',str(proc.pid),'/T','/F'],capture_output=True)
