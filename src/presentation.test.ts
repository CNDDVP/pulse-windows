import {describe,it,expect} from 'vitest';
import {percentText,resetText,forecast} from './presentation';
import type {ProviderUsage,UsageWindow} from './types';
describe('truthful presentation',()=>{
  it('never draws error/loading as zero',()=>{for(const state of ['error','loading','unavailable'] as const){expect(percentText({state,primary_percent:0,balances:[]} as unknown as ProviderUsage)).toBe('—')}});
  it('separates stale, remaining, and money',()=>{expect(percentText({state:'stale',primary_percent:30} as ProviderUsage,'remaining')).toBe('70%*');expect(percentText({state:'live',primary_percent:null,balances:[{currency:'USD',amount:3}]} as ProviderUsage)).toBe('余额')});
  it('does not guess reset or forecast',()=>{expect(resetText(null)).toBe('未报告重置时间');expect(forecast({window_seconds:null,resets_at:'2030-01-01T00:00:00Z'} as UsageWindow)).toBeNull()});
  it('expired date is not future reset',()=>{expect(resetText('2026-01-01T00:00:00Z',Date.parse('2026-01-02T00:00:00Z'))).toContain('等待')});
});
