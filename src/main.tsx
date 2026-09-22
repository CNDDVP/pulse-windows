import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { TrayLabelsBridge } from './trayBridge.tsx'
import { presetDocumentThemeFromCache } from './lib/theme.ts'

// Round5d 修复：设置异步加载完成前，用上次缓存的主题预设 data-theme，
// 消除浅色用户（translucent）在 main/settings 窗口首帧的深色闪烁；
// 无缓存时保持深色默认（:root 即深色）。真实设置加载后仍由 applyDocumentTheme 覆盖。
presetDocumentThemeFromCache()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    {/* Round5c 项目一（misc 域）：托盘菜单标签桥——把词典 misc.tray.* 按当前语言下发给
        tray.rs（原生菜单走不了前端 t()）。各窗口各挂一份，同值重发幂等。 */}
    <TrayLabelsBridge />
  </StrictMode>,
)
