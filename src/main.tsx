import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { TrayLabelsBridge } from './trayBridge.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    {/* Round5c 项目一（misc 域）：托盘菜单标签桥——把词典 misc.tray.* 按当前语言下发给
        tray.rs（原生菜单走不了前端 t()）。各窗口各挂一份，同值重发幂等。 */}
    <TrayLabelsBridge />
  </StrictMode>,
)
