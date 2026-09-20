import json, os, socket, subprocess, tempfile, time, urllib.request, ctypes
from ctypes import wintypes
from pathlib import Path
import websocket

root=Path(__file__).resolve().parent.parent/'release-artifacts'
data=Path(tempfile.mkdtemp(prefix='pulse-v047-native-'))
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
proc=subprocess.Popen([str(root/'pulse-v047-audit-fixes.exe')],env=env,creationflags=subprocess.CREATE_NO_WINDOW)
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
 # Cold first open must reach matching physical bounds, not a timeout force-show.
 invoke(main,'set_window_state',{'state':'rail'})
 invoke(main,'show_detail',{'accountId':'fixture','centerRatio':.5,'horizontalRatio':.5})
 time.sleep(.4)
 geometry=evaluate(detail,'({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})')
 layout=invoke(main,'get_detail_layout')
 assert layout and abs(geometry['w']*geometry['dpr']-layout['width'])<=3 and abs(geometry['h']*geometry['dpr']-layout['height'])<=3,(geometry,layout)
 def detail_visible():
  found=[]
  callback=ctypes.WINFUNCTYPE(wintypes.BOOL,wintypes.HWND,wintypes.LPARAM)
  @callback
  def visit(hwnd,_):
   pid=wintypes.DWORD();ctypes.windll.user32.GetWindowThreadProcessId(hwnd,ctypes.byref(pid))
   title=ctypes.create_unicode_buffer(256);ctypes.windll.user32.GetWindowTextW(hwnd,title,256)
   if pid.value==proc.pid and title.value=='Pulse 详情':found.append(bool(ctypes.windll.user32.IsWindowVisible(hwnd)))
   return True
  ctypes.windll.user32.EnumWindows(visit,0)
  return any(found)
 visible=detail_visible()
 assert visible is True, ('detail hidden despite matching layout',geometry,layout)
 invoke(main,'hide_detail')
 assert detail_visible() is False
 assert invoke(main,'detail_layout_ready',{'requestId':layout['request_id']}) is False
 time.sleep(.1)
 assert detail_visible() is False
 invoke(main,'set_window_state',{'state':'rail'})
 time.sleep(1.75)
 collapsed_width=evaluate(main,'innerWidth')
 assert collapsed_width==24, ('collapse did not finish before forced fallback',collapsed_width)
 result={'collapsed_width':collapsed_width,'cold_detail_geometry':geometry,'requested_bounds':[layout['width'],layout['height']], 'first_open_visible':True,'stale_ack_rejected':True,'pid':proc.pid,'data_dir':str(data)}
 print(json.dumps(result),flush=True)
 (root/'native-regression-result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
finally:
 for ws in connections:ws.close()
 if proc.poll() is None:subprocess.run(['taskkill','/PID',str(proc.pid),'/T','/F'],capture_output=True)
