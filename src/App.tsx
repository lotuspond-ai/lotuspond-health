import { useEffect } from 'react';
import BodyMap from './pages/BodyMap';
import Biomarkers from './pages/Biomarkers';
import Scans from './pages/Scans';
import { MarkerDrawer, ScanViewer, UploadDialog } from './components/Overlays';
import { Icon, Logo } from './components/ui';
import { useUI, type View } from './state/ui';
import { hydrate } from './lib/store';

const NAV: { id: View; label: string }[] = [{ id: 'body', label: 'Body map' }, { id: 'markers', label: 'Biomarkers' }, { id: 'scans', label: 'Scans' }];

export default function App() {
  const { view, setView, setUploadOpen } = useUI();
  useEffect(() => { void hydrate(); }, []);
  useEffect(() => {
    const fromHash = () => { const h = location.hash.slice(1) as View; if (NAV.some(n => n.id === h)) setView(h); };
    fromHash(); window.addEventListener('hashchange', fromHash); return () => window.removeEventListener('hashchange', fromHash);
  }, [setView]);
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#body" onClick={() => setView('body')}><Logo /><b>LotusPond <span>Health</span></b></a>
        <nav className="nav" aria-label="Main">
          {NAV.map(n => <button key={n.id} aria-current={view === n.id ? 'page' : undefined} onClick={() => { setView(n.id); history.replaceState(null, '', `#${n.id}`); }}>{n.label}</button>)}
        </nav>
        <div className="topbar__end">
          <span className="privacy">{Icon.lock} Stays on this device</span>
          <button className="btn btn--primary" onClick={() => setUploadOpen(true)}>{Icon.upload} Upload</button>
        </div>
      </header>
      {view === 'body' ? <BodyMap /> : view === 'markers' ? <Biomarkers /> : <Scans />}
      <MarkerDrawer />
      <UploadDialog />
      <ScanViewer />
    </div>
  );
}
