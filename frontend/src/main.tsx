import { Buffer } from 'buffer';
// The `qrcode` package touches Buffer when producing a data URL — polyfill it.
(window as unknown as Record<string, unknown>)['Buffer'] = Buffer;

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
