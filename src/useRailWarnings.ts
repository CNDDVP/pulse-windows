import {useEffect,useState} from 'react';
import {listen} from '@tauri-apps/api/event';
import {invoke} from '@tauri-apps/api/core';
import type {AppSettings,ProviderUsage} from './types';
import {advanceRail,evaluateRail,railConfig,type RailTransition} from './railWarnings';
import {t,useLang} from './lib/i18n';

export function useRailWarnings(settings:AppSettings,usages:ProviderUsage[]) {
  // lang 入 deps：预警文案在 railWarnings 内经模块级 t() 取词，语言切换后需立即重算一次，
  // 不必等下一个 1s tick。
  const {lang}=useLang();
  const [refreshing,setRefreshing]=useState<Record<string,number>>({});
  useEffect(()=>{
    const stop=listen<{account_id:string;request_id:number;phase:string}>('refresh-state',e=>setRefreshing(old=>{
      const next={...old},p=e.payload;
      if(p.phase==='started')next[p.account_id]=p.request_id;
      else if(next[p.account_id]===p.request_id)delete next[p.account_id];
      return next;
    }));return()=>{void stop.then(f=>f())};
  },[]);
  const key=JSON.stringify([railConfig(settings),settings.collapsed_bar_color_mode,
    Object.entries(settings.providers).map(([id,c])=>[id,c.enabled,c.primary_window])]);
  const [state,setState]=useState<RailTransition>(()=>advanceRail(null,evaluateRail(settings,usages),key,Date.now()));
  useEffect(()=>{
    const tick=()=>setState(old=>advanceRail(old,evaluateRail(settings,usages),key,Date.now()));
    tick();const timer=setInterval(tick,1000);return()=>clearInterval(timer);
  },[settings,usages,key,lang]);
  const selected=railConfig(settings);
  const refreshingSelected=Object.keys(refreshing).some(id=>settings.providers[id]?.enabled&&(selected.scope==='all'||selected.account_ids.includes(id)));
  const result={
    ...state.shown,
    reason:state.shown.reason+(refreshingSelected?t('rail.warn.refreshing_suffix_long'):''),
    shortReason:state.shown.shortReason+(refreshingSelected?t('rail.warn.refreshing_suffix'):''),
  };
  useEffect(()=>{
    void invoke('publish_rail_warning',{
      snapshot:{
        ...result,
        pending:state.pending
      }
    }).catch(()=>{});
  },[state,refreshingSelected]);
  return result;
}
