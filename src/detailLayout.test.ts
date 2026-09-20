import { expect, it } from 'vitest';
import { detailViewportReady } from './detailLayout';

it('waits for both viewport resize and target DPI before revealing the first frame', () => {
  expect(detailViewportReady(380, 340, 1, 510, 540)).toBe(false);
  expect(detailViewportReady(340, 360, 1, 510, 540)).toBe(false);
  expect(detailViewportReady(340, 360, 1.5, 510, 540)).toBe(true);
  expect(detailViewportReady(340, 360, 2, 680, 720)).toBe(true);
  expect(detailViewportReady(339, 360, 1.5, 510, 540)).toBe(true); // 1px rounding variance
  expect(detailViewportReady(340, 359, 1.25, 425, 450)).toBe(true); // 1.25 scale tolerance
});
