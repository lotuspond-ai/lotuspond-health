import { useEffect, type ReactNode } from 'react';
import BodyMap from './pages/BodyMap';
import Biomarkers from './pages/Biomarkers';
import Scans from './pages/Scans';
import DataPage from './pages/Data';
import { MarkerDrawer, ScanViewer, UploadDialog } from './components/Overlays';
import { Icon, Logo } from './components/ui';
import { useUI, type View } from './state/ui';
import { hydrate, useHealth } from './lib/store';

const NAV: { id: View; label: string; short: string; icon: ReactNode }[] = [
  { id: 'body', label: 'Body map', short: 'Body', icon: Icon.body },
  { id: 'markers', label: 'Biomarkers', short: 'Markers', icon: Icon.markers },
  { id: 'scans', label: 'Scans', short: 'Scans', icon: Icon.scans },
  { id: 'data', label: 'Your data', short: 'Data', icon: Icon.data },
];

export default function App() {
  const { view, setView, setUploadOpen } = useUI();
  const saveBlocked = useHealth(s => s.saveBlocked);
  useEffect(() => { void hydrate(); }, []);
  useEffect(() => {
    const fromHash = () => { const h = location.hash.slice(1) as View; if (NAV.some(n => n.id === h)) setView(h); };
    fromHash(); window.addEventListener('hashchange', fromHash); return () => window.removeEventListener('hashchange', fromHash);
  }, [setView]);
  // Keep the address in step with the view, whichever control changed it (no history entries are added).
  useEffect(() => { if (location.hash.slice(1) !== view) history.replaceState(null, '', `#${view}`); }, [view]);
  const tab = (n: (typeof NAV)[number]) => (
    <button key={n.id} aria-current={view === n.id ? 'page' : undefined} onClick={() => setView(n.id)}>{n.icon}<span>{n.short}</span></button>
  );
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#body" onClick={() => setView('body')}><Logo /><b>LotusPond <span>Health</span></b></a>
        <nav className="nav" aria-label="Main">
          {NAV.map(n => <button key={n.id} aria-current={view === n.id ? 'page' : undefined} onClick={() => setView(n.id)}>{n.label}</button>)}
        </nav>
        <div className="topbar__end">
          <span className="privacy">{Icon.lock} <span>Stays on this device</span></span>
          <button className="btn btn--primary topbar__upload" onClick={() => setUploadOpen(true)}>{Icon.upload} Upload</button>
        </div>
      </header>
      {saveBlocked && (
        <p className="warn app__warn" role="alert">LotusPond couldn't open your saved results, so nothing you add now will be saved. Close and reopen the app to try again.</p>
      )}
      <BodyMap hidden={view !== 'body'} />
      {view === 'markers' && <Biomarkers />}
      {view === 'scans' && <Scans />}
      {view === 'data' && <DataPage />}
      <nav className="tabbar" aria-label="Main">
        {NAV.slice(0, 2).map(tab)}
        <button className="tabbar__add" onClick={() => setUploadOpen(true)}><span className="tabbar__plus">{Icon.plus}</span><span>Add</span></button>
        {NAV.slice(2).map(tab)}
      </nav>
      <MarkerDrawer />
      <UploadDialog />
      <ScanViewer />
    </div>
  );
}
