import { useState, type FormEvent } from 'react';
import { categories } from '../workflows';
import type { Profile } from '../worker/db';
import type { Message } from '../i18n/messages';
import { useLanguage } from './Language';
import { message, request, type Session } from './api';

export function Credentials({ onAccount }: { onAccount: (user: Profile, onboarding: boolean) => void }) {
  const { t } = useLanguage();
  const [signup, setSignup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message>();
  const [invalid, setInvalid] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const values: Record<string, unknown> = Object.fromEntries(formData);
    if (signup) values.privacy_consent = formData.get('privacy_consent') === 'on';
    setError(undefined);
    setInvalid('');
    const firstInvalid = Array.from(form.elements).find(element => element instanceof HTMLInputElement &&
      (!element.validity.valid || (element.name === 'nickname' && !element.value.trim()) ||
        (signup && element.name === 'password' && element.value.length < 12)));
    if (firstInvalid instanceof HTMLInputElement) {
      setInvalid(firstInvalid.name);
      firstInvalid.focus();
      return;
    }
    setBusy(true);
    try {
      const { user } = await request<Session>(signup ? '/register' : '/login', 'POST', values);
      if (user) onAccount(user, signup);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  function issue(name: string) {
    return invalid === name ? { 'aria-invalid': true, 'aria-describedby': 'credentials-error' } : {};
  }

  return <section className="panel">
    <h1>{t(signup ? 'create' : 'signIn')}</h1>
    <p>{t('authHelp')}</p>
    <form key={String(signup)} onSubmit={submit} onChange={() => { setInvalid(''); setError(undefined); }} noValidate className="stack">
      <label>{t('email')}<input {...issue('email')} name="email" type="email" dir="ltr"
        autoComplete="email" autoCapitalize="none" spellCheck={false} maxLength={254} required /></label>
      <label>{t('password')}<input {...issue('password')} name="password" type="password" dir="ltr"
        autoComplete={signup ? 'new-password' : 'current-password'} minLength={signup ? 12 : 1} maxLength={128} required />
        {signup && <small>{t('passwordHelp')}</small>}</label>
      {signup && <label>{t('publicNickname')}<input {...issue('nickname')} name="nickname" dir="auto"
        autoComplete="nickname" maxLength={40} required /></label>}
      {signup && <label>{t('betaInvite')}<input {...issue('invite_code')} name="invite_code" type="password" dir="ltr"
        autoComplete="off" maxLength={128} required /></label>}
      {signup && <label className="consent-choice"><input {...issue('privacy_consent')} type="checkbox" name="privacy_consent" required />
        <span>{t('privacyConsent')} <a href="/privacy" target="_blank" rel="noreferrer">{t('privacyNotice')}</a></span></label>}
      {(error || invalid) && <p role="alert" id="credentials-error" className="error">
        {t(error ?? (invalid === 'email' ? 'fieldEmail' : invalid === 'password' && signup ? 'passwordHelp' : 'credentials'))}
      </p>}
      <div className="actions">
        <button disabled={busy}>{t(busy ? 'working' : signup ? 'continue' : 'signIn')}</button>
        <button className="secondary" type="button" disabled={busy} onClick={() => {
          setError(undefined);
          setInvalid('');
          setSignup(!signup);
        }}>{t(signup ? 'back' : 'create')}</button>
      </div>
    </form>
  </section>;
}

export function DeleteAccount() {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<Message>();
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(undefined);
    const password = String(new FormData(event.currentTarget).get('password') ?? '');
    try {
      await request('/account/delete', 'POST', { password });
      window.location.replace('/');
    } catch (cause) { setError(message(cause)); setBusy(false); }
  }
  return <section className="delete-account">
    <h2>{t('deleteAccount')}</h2><p>{t('deleteAccountHelp')}</p>
    {!open ? <button type="button" className="danger-button" onClick={()=>setOpen(true)}>{t('deleteAccount')}</button> :
      <form className="stack" onSubmit={submit}>
        <label>{t('confirmPassword')}<input type="password" name="password" autoComplete="current-password" required /></label>
        {error && <p className="error" role="alert">{t(error)}</p>}
        <button className="danger-button" disabled={busy}>{t(busy ? 'working' : 'deleteConfirm')}</button>
      </form>}
  </section>;
}

export function Expertise({ user, onboarding, onSave, onSkip }: {
  user: Profile;
  onboarding: boolean;
  onSave: (user: Profile) => void;
  onSkip: () => void;
}) {
  const { t, l } = useLanguage();
  const [selected, setSelected] = useState(() =>
    categories.filter(category => user.expertise.includes(category.value)).map(category => category.value));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message>();
  const [saved, setSaved] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      const result = await request<Session>('/profile/expertise', 'PUT', { expertise: selected });
      if (result.user) onSave(result.user);
      setSaved(true);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  return <form onSubmit={submit} className="stack">
    <fieldset disabled={busy} aria-describedby="expertise-help">
      <legend>{t(onboarding ? 'chooseExpertise' : 'expertise')}</legend>
      <p id="expertise-help">{t('expertiseHelp')}</p>
      <div className="choices">
        {categories.map(({ value, label }) => <label className="choice" key={value}>
          <input type="checkbox" checked={selected.includes(value)} onChange={event => {
            setSaved(false);
            setSelected(event.target.checked ? [...selected, value] : selected.filter(id => id !== value));
          }} />
          {l(label)}
        </label>)}
      </div>
    </fieldset>
    {error && <p role="alert" className="error">{t(error)}</p>}
    {saved && <p role="status">{t('saved')}</p>}
    <div className="actions">
      <button disabled={busy || (onboarding && !selected.length)}>{t(busy ? 'saving' : 'save')}</button>
      {onboarding && <button className="secondary" type="button" disabled={busy} onClick={onSkip}>{t('skip')}</button>}
    </div>
  </form>;
}
