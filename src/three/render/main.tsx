// Entry of tools/bodymap-render.html (see RenderPage.tsx).
import { createRoot } from 'react-dom/client';
import { useHealth } from '../../lib/store';
import { useUI } from '../../state/ui';
import { RenderScene } from './RenderPage';

useUI.setState({ layers: { skin: true, skeleton: true, labels: false }, hovered: null, xray: false, section: { on: false, axis: 'coronal', depth: 0.5 } });
useHealth.setState({ selectedOrgan: null, activeSystem: null });
createRoot(document.getElementById('root')!).render(<RenderScene />);
