import { Buffer } from 'buffer';
// amazon-cognito-identity-js uses Buffer — polyfill it for the browser
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
