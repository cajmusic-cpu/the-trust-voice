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
