import io
p='src/pages/SettingsWindow.tsx'
s=io.open(p,encoding='utf-8').read()
def rep(a,b,n=1):
    global s
    assert s.count(a)==n,(a[:80],s.count(a)); s=s.replace(a,b)

# add-account defaults include the new fields
rep('''      primary_window: null,
      elapsed_window: null,
      ring_color: null,
      low_balance: null,
      low_balance_currency: null
    });''','''      primary_window: null,
      elapsed_window: null,
      ring_color: null,
      low_balance: null,
      low_balance_currency: null,
      mark_mode: null,
      bot_persona: null,
      bot_shape: null,
      bot_color: null,
      secondary_window: null,
      split_model_groups: false
    });''')

# account 悬浮栏 section: after 圆环颜色 row, add mark/bot/secondary/split controls
rep('''                  <Row title="圆环颜色" subtitle="自定义颜色用于正常区间；达到琥珀/红色阈值或服务商报告耗尽时仍按预警色显示。">
                    <div className="flex items-center gap-2">
                      <select className={selectCls} value={c.ring_color ? "custom" : "auto"} onChange={e => patch(id, { ring_color: e.target.value === "custom" ? (c.ring_color ?? "#10b981") : null })} aria-label="圆环颜色模式"><option value="auto">自动（按用量压力）</option><option value="custom">自定义</option></select>
                      {c.ring_color && <input type="color" value={c.ring_color} onChange={e => patch(id, { ring_color: e.target.value })} className="w-9 h-8 rounded-lg bg-transparent border border-zinc-700 cursor-pointer" aria-label="选择圆环颜色" />}
                    </div>
                  </Row>
                </Section>''','''                  <Row title="圆环颜色" subtitle="自定义颜色用于正常区间；达到琥珀/红色阈值或服务商报告耗尽时仍按预警色显示。">
                    <div className="flex items-center gap-2">
                      <select className={selectCls} value={c.ring_color ? "custom" : "auto"} onChange={e => patch(id, { ring_color: e.target.value === "custom" ? (c.ring_color ?? "#10b981") : null })} aria-label="圆环颜色模式"><option value="auto">自动（按用量压力）</option><option value="custom">自定义</option></select>
                      {c.ring_color && <input type="color" value={c.ring_color} onChange={e => patch(id, { ring_color: e.target.value })} className="w-9 h-8 rounded-lg bg-transparent border border-zinc-700 cursor-pointer" aria-label="选择圆环颜色" />}
                    </div>
                  </Row>
                  <Row title="动画机器人" subtitle="用一个会反应账号状态的小机器人替代服务商图标；个性、形状、颜色可调。">
                    <Switch checked={c.mark_mode === "bot"} onChange={v => patch(id, { mark_mode: v ? "bot" : "icon" })} label="动画机器人" />
                  </Row>
                  {c.mark_mode === "bot" && (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1">
                      <Field label="个性"><select className={selectCls} value={c.bot_persona ?? ""} onChange={e => patch(id, { bot_persona: e.target.value || null })}><option value="">自动（安静）</option>{BOT_PERSONAS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></Field>
                      <Field label="形状"><select className={selectCls} value={c.bot_shape ?? ""} onChange={e => patch(id, { bot_shape: e.target.value || null })}><option value="">自动（圆润）</option>{BOT_SHAPES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></Field>
                      <Field label="颜色"><div className="flex items-center gap-2">
                        <select className={selectCls} value={c.bot_color ? "custom" : "auto"} onChange={e => patch(id, { bot_color: e.target.value === "custom" ? (c.bot_color ?? "#10b981") : null })} aria-label="机器人颜色模式"><option value="auto">跟随主题</option><option value="custom">自定义</option></select>
                        {c.bot_color && <input type="color" value={c.bot_color} onChange={e => patch(id, { bot_color: e.target.value })} className="w-9 h-8 rounded-lg bg-transparent border border-zinc-700 cursor-pointer" aria-label="选择机器人颜色" />}
                      </div></Field>
                    </div>
                  )}
                  {reading?.windows && reading.windows.length > 1 && (
                    <Field label="第二额度内环（可选）" hint="在主环内侧用细环显示另一项额度；自动优先选同一模型组里最满的一项。">
                      <select className={selectCls} value={c.secondary_window || ""} onChange={e => patch(id, { secondary_window: e.target.value || null })}>
                        <option value="">关闭</option>
                        {reading.windows.map(w => <option key={w.id} value={w.id}>{w.name} — 已使用 {w.used_percent.toFixed(1)}%</option>)}
                      </select>
                    </Field>
                  )}
                  {c.provider_id === "antigravity" && (
                    <Row title="按模型组拆分展示" subtitle="Gemini 与 Claude/GPT 各占一个悬浮栏位置；点击任一项仍刷新同一账号。">
                      <Switch checked={c.split_model_groups} onChange={v => patch(id, { split_model_groups: v })} label="按模型组拆分展示" />
                    </Row>
                  )}
                </Section>''')
io.open(p,'w',encoding='utf-8',newline='\n').write(s)
print("settings account page ok")
