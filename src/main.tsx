import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Fonts ship with the app (no font CDN), so it works offline and makes no third-party requests.
import '@fontsource-variable/hanken-grotesk/index.css';
import '@fontsource-variable/newsreader/opsz.css';
import './index.css';
import App from './App';
import { initNative } from './native';

initNative();

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
