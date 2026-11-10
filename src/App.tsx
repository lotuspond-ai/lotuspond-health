import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import BodyMap from './pages/BodyMap';
import Biomarkers from './pages/Biomarkers';
import Scans from './pages/Scans';
import Files from './pages/Files';
import ProfilePage from './pages/Profile';
import AccountPage from './pages/Account';
import Labs from './pages/Labs';
import { MarkerDrawer, ScanViewer, UploadDialog } from './components/Overlays';
import { BookingDialog } from './components/labs/BookingDialog';
import { ResultReview } from './components/labs/ResultReview';
import { useLabFollow } from './components/labs/useLabFollow';
import { useLab } from './state/lab';
import { AuthScreen, Offline, Splash } from './components/Auth';
import { Onboarding } from './components/Onboarding';
import { AddProfileDialog, ProfileMenu, Toasts } from './components/ProfileMenu';
import { LockScreen } from './components/AppLock';
import { Icon, Logo } from './components/ui';
import { isPreview } from './api';
import { useSession } from './state/session';
import { authModeFromLocation, siteHref, siteLinkProps } from './site/links';
import { toast } from './state/toast';
import { errorMessage } from './api';
import { useUI, VIEWS, type View } from './state/ui';
import { useLock } from './native/lock';
import { sessionReady } from './native';

const NAV: { id: View; label: string }[] = [
  { id: 'body', label: 'Body map' }, { id: 'markers', label: 'Biomarkers' }, { id: 'scans', label: 'Scans' }, { id: 'files', label: 'Files' },
  { id: 'labs', label: 'Find a lab' },
];

/** Phone tab bar (shown below 760px): four places and Add in the middle. Scans sit with Files. */
const TABS: { id: View; label: string; icon: ReactNode; also?: View[] }[] = [
  { id: 'body', label: 'Body', icon: Icon.body },
  { id: 'markers', label: 'Results', icon: Icon.markers },
  { id: 'labs', label: 'Labs', icon: Icon.pin },
  { id: 'files', label: 'Files', icon: Icon.file, also: ['scans'] },
];

export default function App() {
  const status = useSession(s => s.status);
  const onboarding = useSession(s => s.onboarding);
  const locked = useLock(s => s.status !== 'open');
  const ready = status === 'signed-in' && !onboarding;
  // Once shown, the app (and its WebGL stage) stays mounted and is only hidden while signed out. Tearing the
  // stage down and rebuilding it on every sign-in re-parses the model and recompiles every shader, and the
  // R3F/drei teardown path has proved fragile.
  const [shellMounted, setShellMounted] = useState(false);
  if (ready && !shellMounted) setShellMounted(true);
  // In the apps the session (and the records with it) loads only once the app lock allows it.
  useEffect(() => { void sessionReady.then(() => useSession.getState().init()); }, []);
  // While the app lock is up, nothing behind it can be reached (focus, screen readers, taps).
  useEffect(() => {
    const root = document.getElementById('root');
    if (root) root.inert = locked;
  }, [locked]);
  return (
    <>
      {!ready && (status === 'loading' ? <Splash /> : status === 'offline' ? <Offline /> : status === 'signed-out' ? <AuthScreen initialMode={authModeFromLocation()} /> : <Onboarding />)}
      {shellMounted && <Shell hidden={!ready} />}
      <Toasts />
      {locked && createPortal(<LockScreen />, document.body)}
    </>
  );
}

function Shell({ hidden }: { hidden: boolean }) {
  const { view, setView, setUploadOpen } = useUI();
  useLabFollow(!hidden);
  // Lab results waiting to be checked: a count on Find a lab.
  const ready = useLab(s => s.results.filter(r => r.status === 'pending').length);
  const badge = (id: View) => (id === 'labs' && ready > 0 ? <span className="nav__badge" aria-label={`, ${ready} lab result${ready === 1 ? '' : 's'} to check`}>{ready}</span> : null);
  useEffect(() => {
    if (hidden) return;
    const fromHash = () => { const h = location.hash.slice(1) as View; if (VIEWS.includes(h)) setView(h); };
    fromHash(); window.addEventListener('hashchange', fromHash); return () => window.removeEventListener('hashchange', fromHash);
  }, [setView, hidden]);
  const tab = (t: (typeof TABS)[number]) => {
    const current = view === t.id || !!t.also?.includes(view);
    return <button key={t.id} aria-current={current ? 'page' : undefined} onClick={() => setView(t.id)}>{t.icon}<span>{t.label}</span>{badge(t.id)}</button>;
  };
  return (
    <div className="app" hidden={hidden}>
      <header className="topbar">
        <a className="brand" href="#body" onClick={() => setView('body')}><Logo /><b>LotusPond <span>Health</span></b></a>
        <nav className="nav" aria-label="Main">
          {NAV.map(n => <button key={n.id} aria-current={view === n.id ? 'page' : undefined} onClick={() => setView(n.id)}>{n.label}{badge(n.id)}</button>)}
        </nav>
        <div className="topbar__end">
          {isPreview && <span className="privacy" title="This preview has no server. Your account and records are saved in this browser only.">{Icon.lock} Preview · saved in this browser</span>}
          <button className="btn btn--primary topbar__upload" onClick={() => setUploadOpen(true)}>{Icon.upload} Upload</button>
          <ProfileMenu />
        </div>
      </header>
      <UpdatedTextsNotice />
      <BodyMap hidden={view !== 'body'} />
      {!hidden && <>
        {(view === 'files' || view === 'scans') && <FilesSwitch view={view} />}
        {view === 'markers' && <Biomarkers />}
        {view === 'scans' && <Scans />}
        {view === 'files' && <Files />}
        {view === 'profile' && <ProfilePage />}
        {view === 'account' && <AccountPage />}
        {view === 'labs' && <Labs />}
        <MarkerDrawer />
        <UploadDialog />
        <ScanViewer />
        <AddProfileDialog />
        <BookingDialog />
        <ResultReview />
      </>}
      <nav className="tabbar" aria-label="Main">
        {TABS.slice(0, 2).map(tab)}
        <button className="tabbar__add" onClick={() => setUploadOpen(true)}><span className="tabbar__plus">{Icon.plus}</span><span>Add</span></button>
        {TABS.slice(2).map(tab)}
      </nav>
    </div>
  );
}

/**
 * The Terms or Privacy Policy changed since the person accepted them (SessionInfo.consentsOutdated): say what changed
 * and record their acceptance of the current texts. The app stays usable meanwhile.
 */
function UpdatedTextsNotice() {
  const outdated = useSession(s => s.consentsOutdated);
  const accept = useSession(s => s.acceptUpdatedTexts);
  const [busy, setBusy] = useState(false);
  if (!outdated.length) return null;
  // One consent version covers both texts; name the one that changed (the Privacy Policy, for agent sharing).
  const names = outdated.includes('privacy') ? 'Privacy Policy' : 'Terms';
  return (
    <div className="texts-notice" role="status">
      <p><b>We updated our {names}.</b> It now explains how AI agents you connect can read the records you choose for them. <a href={siteHref('/privacy/')} {...siteLinkProps}>Read what changed</a></p>
      <button type="button" className="btn btn--primary" disabled={busy} onClick={async () => {
        setBusy(true);
        try { await accept(); toast.info('Thank you. Your acceptance is recorded on Account.'); } catch (e) { toast.error(errorMessage(e)); setBusy(false); }
      }}>{busy ? 'Saving…' : 'Accept'}</button>
    </div>
  );
}

/** On phones Files and Scans share a tab; this switch sits above either page there. */
function FilesSwitch({ view }: { view: View }) {
  const setView = useUI(s => s.setView);
  return (
    <div className="files-switch seg" role="group" aria-label="Show">
      <button aria-pressed={view === 'files'} onClick={() => setView('files')}>Reports and files</button>
      <button aria-pressed={view === 'scans'} onClick={() => setView('scans')}>Scans</button>
    </div>
  );
}
