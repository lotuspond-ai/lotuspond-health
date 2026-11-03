import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { backend } from './api';
import { configureStore } from './lib/store';
import { toast } from './state/toast';
import './sw-register';

configureStore({ backend, onError: toast.error });

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
