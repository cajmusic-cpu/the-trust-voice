import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { vi } from 'vitest';

// jsdom does not implement the HTMLMediaElement playback methods. The component
// only calls these from user gestures the tests don't trigger, but stub them so
// an accidental call can't throw "Not implemented".
Object.defineProperty(HTMLMediaElement.prototype, 'play', {
  configurable: true,
  value: vi.fn().mockResolvedValue(undefined),
});
Object.defineProperty(HTMLMediaElement.prototype, 'load', {
  configurable: true,
  value: vi.fn(),
});

// Load the real app stylesheet so getComputedStyle() reflects production rules —
// needed to guard against layout/stacking regressions (e.g. an invisible element
// covering an interactive one) that behavioural jsdom tests can't otherwise see.
const cssPath = resolve(process.cwd(), 'src/index.css');
const styleEl = document.createElement('style');
styleEl.textContent = readFileSync(cssPath, 'utf8');
document.head.appendChild(styleEl);
