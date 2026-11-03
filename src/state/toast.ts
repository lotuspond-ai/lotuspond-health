import { create } from 'zustand';

export interface Toast { id: number; tone: 'info' | 'error'; text: string }

interface ToastState {
  toasts: Toast[];
  push: (text: string, tone?: Toast['tone']) => void;
  dismiss: (id: number) => void;
}

let next = 1;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (text, tone = 'info') => {
    const id = next++;
    // Repeated identical messages (for example several failed saves) show once.
    if (get().toasts.some(t => t.text === text)) return;
    set(s => ({ toasts: [...s.toasts.slice(-3), { id, tone, text }] }));
    setTimeout(() => get().dismiss(id), tone === 'error' ? 7000 : 4000);
  },
  dismiss: id => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),
}));

export const toast = {
  info: (text: string) => useToasts.getState().push(text, 'info'),
  error: (text: string) => useToasts.getState().push(text, 'error'),
};
