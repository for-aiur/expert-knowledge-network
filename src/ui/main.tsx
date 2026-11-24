import { Activity, CaseDetail, CaseList, Leaderboard, ReviewQueue } from './RepairScreens';
import type { Repair } from '../repair';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { workflowFor } from '../workflows';
import type { Profile } from '../worker/db';
import type { Message } from '../i18n/messages';
import { Credentials, DeleteAccount, Expertise } from './Account';
import { message, request, type Session } from './api';
import { WorkflowForm } from './WorkflowForm';
import { Icon } from './Icon';
import { LanguagePicker, LanguageProvider, useLanguage } from './Language';
import { AdminExplorer } from './AdminExplorer';
import './styles.css';

const navigation = [
  ['/', 'home'], ['/submit', 'submit'], ['/cases', 'reports'], ['/reviews', 'reviews'],
  ['/leaderboard', 'leaderboard'], ['/profile', 'profile'],
] as const;

function App() {
  const { t } = useLanguage();
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  const [user, setUser] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Message>();
  const [onboarding, setOnboarding] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [draftId] = useState(() => path === '/submit' ? new URLSearchParams(window.location.search).get('draft') : null);
  const [draft, setDraft] = useState<Repair>();
  const [draftError, setDraftError] = useState<Message>();
  const caseRoute = /^\/(cases|community)\/([a-f0-9-]+)$/i.exec(path);
  const workflow = workflowFor('repair_case', draft?.schema_version);

  useEffect(() => {
    if (!draftId) return;
    request<Repair>('/v1/me/submissions/' + encodeURIComponent(draftId)).then(data => {
      if (data.status === 'draft') setDraft(data);
      else window.location.replace('/cases/' + data.id);
    }).catch(cause => setDraftError(message(cause)));
  }, [draftId]);

  useEffect(() => {
    request<Session>('/session').then(data => setUser(data.user))
      .catch(cause => setError(message(cause))).finally(() => setLoading(false));
  }, []);

  async function signOut() {
    setSigningOut(true);
    setError(undefined);
    try {
      await request<Session>('/logout', 'POST');
      setUser(null);
      setOnboarding(false);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSigningOut(false);
    }
  }

  return <>
    <header className="site-header">
      <div className="frame header-inner">
        <a className="brand" href="/"><span className="brand-mark"><Icon name="mark" /></span>
          <bdi>Expert Knowledge Network</bdi></a>
        <nav aria-label={t('navigation')}>{navigation.map(([href, name]) =>
          <a href={href} key={href} aria-current={path === href ? 'page' : undefined}>
            <Icon name={name} /><span>{t(name === 'leaderboard' ? 'rankingNav' : name)}</span></a>)}
          {user?.is_admin && <a className="admin-link" href="/admin" aria-current={path === '/admin' ? 'page' : undefined}>
            <Icon name="profile" /><span>{t('adminNav')}</span></a>}
        </nav>
        <LanguagePicker />
      </div>
    </header>
    <main className="frame">
      {error && <p role="alert" className="error">{t(error)}</p>}
      {path === '/' && <section className="hero">
        <div className="hero-body">
          <h1>{t('hero')}</h1>
          <p>{t('intro')}</p>
          <div className="actions"><a className="button" href="/submit">{t('newRepair')}</a>
            <a className="button secondary" href="/profile">{t(user ? 'openProfile' : 'join')}</a>
            <a className="button secondary" href="/community">{t('communityCases')}</a></div>
        </div>
        <div className="hero-mark" aria-hidden="true"><Icon name="mark" /></div>
      </section>}
      {path === '/submit' && <section className="panel repair-panel">
        <h1><span className="identity-icon"><Icon name="submit" /></span>{t('newRepair')}</h1>
        <p>{t('repairHelp')}</p>
        <div className="actions">
          {user && <a href="/cases">{t('reports')}</a>}
          <a href="/community">{t('communityCases')}</a>
        </div>

        {!draftId || draft ? <WorkflowForm key={draft?.id ?? 'new-repair'}
          workflow={workflow} signedIn={Boolean(user)} draft={draft} />
          : <p role={draftError ? 'alert' : 'status'}>{t(draftError ?? 'loadingData')}</p>}
      </section>}
      {path === '/profile' && (loading ? <p role="status">{t('loading')}</p> : user ? <section className="panel">
        <h1>{t(onboarding ? 'setup' : 'profile')}</h1>
        <div className="identity">
          <span className="identity-icon"><Icon name="profile" /></span>
          <div><small>{t('publicNickname')}</small><strong><bdi>{user.nickname}</bdi></strong></div>
        </div>
        <Expertise key={user.id + String(onboarding)} user={user} onboarding={onboarding}
          onSave={updated => { setUser(updated); setOnboarding(false); }} onSkip={() => setOnboarding(false)} />
        {!onboarding && <div className="account-actions">
          <LanguagePicker />
          <button className="secondary" disabled={signingOut} onClick={signOut}>{t(signingOut ? 'signingOut' : 'signOut')}</button>
        </div>}
        {!onboarding && <Activity />}
        {!onboarding && <DeleteAccount />}
      </section> : <Credentials onAccount={(account, firstVisit) => {
        setUser(account);
        setOnboarding(firstVisit);
      }} />)}
      {path === '/reviews' && <ReviewQueue signedIn={Boolean(user)} />}
      {path === '/leaderboard' && <Leaderboard />}
      {path === '/admin' && (loading ? <p role="status">{t('loading')}</p> : user?.is_admin ? <AdminExplorer /> : <section className="panel"><h1>{t('adminForbidden')}</h1></section>)}
      {path === '/privacy' && <section className="panel"><h1>{t('privacyTitle')}</h1><p>{t('privacyText')}</p></section>}
      {path === '/cases' && <CaseList community={false} />}
      {path === '/community' && <CaseList community />}
      {caseRoute && <CaseDetail id={caseRoute[2]} community={caseRoute[1] === 'community'} />}
      {!caseRoute && !['/cases', '/community', '/admin', '/privacy'].includes(path) && !navigation.some(([href]) => href === path) &&
        <section className="panel"><h1>{t('notFound')}</h1><a href="/">{t('goHome')}</a></section>}
    </main>
  </>;
}

createRoot(document.getElementById('root')!).render(<LanguageProvider><App /></LanguageProvider>);
