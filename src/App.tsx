import { useEffect, useState } from 'react';
import BodyMap from './pages/BodyMap';
import Biomarkers from './pages/Biomarkers';
import Scans from './pages/Scans';
import Files from './pages/Files';
import ProfilePage from './pages/Profile';
import AccountPage from './pages/Account';
import { MarkerDrawer, ScanViewer, UploadDialog } from './components/Overlays';
import { AuthScreen, Offline, Splash } from './components/Auth';
import { Onboarding } from './components/Onboarding';
import { AddProfileDialog, ProfileMenu, Toasts } from './components/ProfileMenu';
import { Icon, Logo } from './components/ui';
import { isPreview } from './api';
import { useSession } from './state/session';
import { useUI, VIEWS, type View } from './state/ui';

const NAV: { id: View; label: string }[] = [
  { id: 'body', label: 'Body map' }, { id: 'markers', label: 'Biomarkers' }, { id: 'scans', label: 'Scans' }, { id: 'files', label: 'Files' },
];

export default function App() {
  const status = useSession(s => s.status);
  const onboarding = useSession(s => s.onboarding);
  const ready = status === 'signed-in' && !onboarding;
  // Once shown, the app (and its WebGL stage) stays mounted and is only hidden while signed out. Tearing the
  // stage down and rebuilding it on every sign-in re-parses the model and recompiles every shader, and the
  // R3F/drei teardown path has proved fragile.
  const [shellMounted, setShellMounted] = useState(false);
  if (ready && !shellMounted) setShellMounted(true);
  useEffect(() => { void useSession.getState().init(); }, []);
  return (
    <>
      {!ready && (status === 'loading' ? <Splash /> : status === 'offline' ? <Offline /> : status === 'signed-out' ? <AuthScreen /> : <Onboarding />)}
      {shellMounted && <Shell hidden={!ready} />}
      <Toasts />
    </>
  );
}

function Shell({ hidden }: { hidden: boolean }) {
  const { view, setView, setUploadOpen } = useUI();
  useEffect(() => {
    if (hidden) return;
    const fromHash = () => { const h = location.hash.slice(1) as View; if (VIEWS.includes(h)) setView(h); };
    fromHash(); window.addEventListener('hashchange', fromHash); return () => window.removeEventListener('hashchange', fromHash);
  }, [setView, hidden]);
  return (
    <div className="app" hidden={hidden}>
      <header className="topbar">
        <a className="brand" href="#body" onClick={() => setView('body')}><Logo /><b>LotusPond <span>Health</span></b></a>
        <nav className="nav" aria-label="Main">
          {NAV.map(n => <button key={n.id} aria-current={view === n.id ? 'page' : undefined} onClick={() => setView(n.id)}>{n.label}</button>)}
        </nav>
        <div className="topbar__end">
          {isPreview && <span className="privacy" title="This preview has no server. Your account and records are saved in this browser only.">{Icon.lock} Preview · saved in this browser</span>}
          <button className="btn btn--primary" onClick={() => setUploadOpen(true)}>{Icon.upload} Upload</button>
          <ProfileMenu />
        </div>
      </header>
      <BodyMap hidden={view !== 'body'} />
      {!hidden && <>
        {view === 'markers' && <Biomarkers />}
        {view === 'scans' && <Scans />}
        {view === 'files' && <Files />}
        {view === 'profile' && <ProfilePage />}
        {view === 'account' && <AccountPage />}
        <MarkerDrawer />
        <UploadDialog />
        <ScanViewer />
        <AddProfileDialog />
      </>}
    </div>
  );
}
