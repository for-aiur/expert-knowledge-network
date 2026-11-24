import { Icon } from './Icon';
import { useEffect, useState, type FormEvent } from 'react';
import { rubricFor, rubricOptions, statuses, type Assignment, type FeedbackEntry, type Page, type Repair } from '../repair';
import { localeNames, isLocale } from '../i18n/messages';
import { workflowFor } from '../workflows';
import type { Message } from '../i18n/messages';
import { useLanguage } from './Language';
import { message, request } from './api';

type CaseView = Pick<Repair, 'content_language' | 'schema_version' | 'values'>;

function useData<T>(path: string) {
  const [state, setState] = useState<{ data?: T; error?: Message }>({});
  useEffect(() => {
    let ignore = false;
    setState({});
    request<T>(path).then(data => { if (!ignore) setState({ data }); })
      .catch(error => { if (!ignore) setState({ error: message(error) }); });
    return () => { ignore = true; };
  }, [path]);
  return state;
}

function Feedback({ error }: { error?: Message }) {
  const { t } = useLanguage();
  return <p role={error ? 'alert' : 'status'} className={error ? 'error' : undefined}>{t(error ?? 'loadingData')}</p>;
}

function Paging({ offset, next, change }: { offset: number; next: number | null; change: (offset: number) => void }) {
  const { t } = useLanguage();
  return <div className="actions">
    {offset > 0 && <button className="secondary" onClick={() => change(Math.max(0, offset - 20))}>{t('previous')}</button>}
    {next !== null && <button className="secondary" onClick={() => change(next)}>{t('next')}</button>}
  </div>;
}

function CaseFacts({ repair }: { repair: CaseView }) {
  const { l, t } = useLanguage();
  const workflow = workflowFor('repair_case', repair.schema_version);
  return <>
    <p className="note">{t('reported')}</p>
    <dl className="case-facts">
      {workflow?.fields.map(field => {
        const value = repair.values[field.name];
        if (!value) return null;
        const option = field.options?.find(item => item.value === value.trim());
        return <div key={field.name}>
          <dt>{field.name === 'outcome' ? t('reportedOutcome') : l(field.label)}</dt>
          <dd dir={field.name === 'fault_code' || field.name === 'model' ? 'ltr' : 'auto'}
            lang={option ? undefined : repair.content_language}>{option ? l(option.label) : value}</dd>
        </div>;
      })}
    </dl>
  </>;
}

export function CaseList({ community }: { community: boolean }) {
  const { t, l, locale } = useLanguage();
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState('');
  const path = community ? '/v1/repairs' : '/v1/me/submissions';
  const { data, error } = useData<Page<Repair>>(path + '?offset=' + offset + (status ? '&status=' + status : ''));
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });

  return <section className="panel">
    <h1>{t(community ? 'communityCases' : 'reports')}</h1>
    {community && <p>{t('communityHelp')}</p>}
    {!community && error !== 'needAccount' && <div className="report-filters" role="group" aria-label={t('filterReports')}>
      {(['', ...statuses] as const).map(item => <button type="button" className="secondary" key={item}
        aria-pressed={item === status} onClick={() => { setOffset(0); setStatus(item); }}>
        {item ? t(item) : t('allReports')}
      </button>)}
    </div>}
    {!data ? error === 'needAccount' ? <p><a href="/profile">{t('needAccount')}</a></p> : <Feedback error={error} /> : <>
      {!data.items.length && <div className="reports-empty">
        <p>{t('noCases')}</p>
        {!community && <a className="button" href="/submit">{t('newRepair')}</a>}
      </div>}
      <ul className="record-list">{data.items.map(repair => {
        const category = workflowFor('repair_case', repair.schema_version)?.fields
          .find(field => field.name === 'equipment_category')?.options?.find(option => option.value === repair.values.equipment_category?.trim());
        const href = (community ? '/community/' : '/cases/') + repair.id;
        const equipment = [repair.values.manufacturer, repair.values.model].filter(value => value?.trim()).join(' · ');
        return <li key={repair.id}><a className="record-link" href={href}>
          <strong>{category ? l(category.label) : t('newRepair')}</strong>
          <span className="status-chip" data-status={repair.status}>{repair.status === 'peer_reviewed' && <Icon name="done" />}{t(repair.status)}</span>
          {!community && <>
            {equipment && <span className="report-equipment" dir="auto">{equipment}</span>}
            {repair.values.fault_code && <span className="report-fault"><bdi dir="ltr">{repair.values.fault_code}</bdi></span>}
            <span className="report-meta">
              <time dateTime={new Date(repair.updated_at * 1000).toISOString()}>{date.format(repair.updated_at * 1000)}</time>
              <bdi>{isLocale(repair.content_language) ? localeNames[repair.content_language] : repair.content_language}</bdi>
              <span>{t(repair.sharing_permission !== 'community' ? 'sharingPrivate' :
                repair.status === 'peer_reviewed' ? 'sharingPublished' : 'sharingAllowed')}</span>
            </span>
          </>}
          {repair.values.symptoms && <span className="record-preview" dir="auto" lang={repair.content_language}>{repair.values.symptoms}</span>}
        </a></li>;
      })}</ul>
      <Paging offset={offset} next={data.next_offset} change={setOffset} />
    </>}
  </section>;
}

function ReviewFeedback({ entry }: { entry: FeedbackEntry }) {
  const { t, l } = useLanguage();
  const rubric = entry.rubric_version === null ? undefined : rubricFor(entry.rubric_version);
  return <div className="review-card">
    <strong>{l(rubricFor().options[entry.assessment])}</strong>
    {rubric && <dl className="case-facts">{rubric.fields.filter(field => field.name !== 'overall_assessment').map(field => {
      const label = rubric.options[entry.answers[field.name]];
      return <div key={field.name}><dt>{l(field.label)}</dt><dd>{label && l(label)}</dd></div>;
    })}</dl>}
    {entry.answers.reasoning && <p className="reasoning-text" dir="auto">{entry.answers.reasoning}</p>}
    {!rubric && <p>{t('legacyReview')}</p>}
  </div>;
}

export function CaseDetail({ id, community }: { id: string; community: boolean }) {
  const { t } = useLanguage();
  const { data, error } = useData<Repair>((community ? '/v1/repairs/' : '/v1/me/submissions/') + encodeURIComponent(id));
  const [revisionError, setRevisionError] = useState<Message>();
  const [busy, setBusy] = useState(false);

  async function revise() {
    setBusy(true);
    setRevisionError(undefined);
    try {
      const revision = await request<{ id: string; status: string }>('/v1/me/submissions/' + id + '/revision', 'POST', {});
      window.location.assign(revision.status === 'draft' ? '/submit?draft=' + revision.id : '/cases/' + revision.id);
    } catch (cause) {
      setRevisionError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  return <section className="panel">
    <h1>{t(community ? 'communityCases' : 'reports')}</h1>
    {!data ? <Feedback error={error} /> : <>
      <p><span className="status-chip" data-status={data.status}>{data.status === 'peer_reviewed' && <Icon name="done" />}{t(data.status)}</span> {data.author_nickname && <bdi>{data.author_nickname}</bdi>}</p>
      {!community && <span className="coming-soon" aria-disabled="true">
        <Icon name="download" />{t('downloadReport')}<span aria-hidden="true">·</span>{t('comingSoon')}
      </span>}
      {data.dissent && <p className="note">{t('dissent')}</p>}
      {data.status === 'draft' && <p><a href={'/submit?draft=' + data.id}>{t('editDraft')}</a></p>}
      {data.previous_revision_id && <p><a href={'/cases/' + data.previous_revision_id}>{t('previousRevision')}</a></p>}
      <CaseFacts repair={data} />
      {Boolean(data.feedback?.length) && <section className="stack">
        <h2>{t('reviewFeedback')}</h2>
        {data.feedback?.map((entry, index) => <ReviewFeedback key={index} entry={entry} />)}
      </section>}
      {data.status === 'needs_clarification' && <div className="stack">
        <p>{t('clarificationHelp')}</p>
        {revisionError && <p className="error" role="alert">{t(revisionError)}</p>}
        <div><button disabled={busy} onClick={() => void revise()}>{t(data.next_revision_id ? 'openRevision' : 'startRevision')}</button></div>
      </div>}
    </>}
    <a className="button secondary case-back" href={community ? '/community' : '/cases'}>{t(community ? 'communityCases' : 'reports')}</a>
  </section>;
}

function ReviewForm({ assignment, onComplete }: { assignment: Assignment; onComplete: () => void }) {
  const { t, l } = useLanguage();
  const [error, setError] = useState<Message>();
  const [busy, setBusy] = useState(false);
  const [assessment, setAssessment] = useState('');
  const rubric = rubricFor(assignment.rubric_version);
  if (!rubric) return <Feedback error="formMissing" />;
  const required = rubric.reasoning.required_for.includes(assessment);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const reasoning = String(fields.get('reasoning') ?? '');
    const answers = Object.fromEntries(rubric.fields.map(field => [field.name, fields.get(field.name)]));
    if ((required && !reasoning.trim()) || Object.values(answers).some(value => !value)) {
      setError('reviewInvalid');
      return;
    }
    setError(undefined);
    setBusy(true);
    try {
      await request('/v1/me/reviews/' + assignment.id, 'POST', { answers, reasoning });
      onComplete();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  return <form className="stack" onSubmit={submit} noValidate>
    <fieldset className="stack" disabled={busy}>
      <legend>{t('independentReview')}</legend>
      {rubric.fields.map(field => <label key={field.name}>{l(field.label)}
        <select name={field.name} defaultValue="" required onChange={event => {
          if (field.name === 'overall_assessment') setAssessment(event.target.value);
        }}>
          <option value="">{t('choose')}</option>
          {rubricOptions(field, assignment.repair.values.outcome?.trim()).map(value =>
            <option key={value} value={value}>{l(rubric.options[value])}</option>)}
        </select>
      </label>)}
      <label>{l(rubric.reasoning.label)} <span className="field-status">{t(required ? 'required' : 'optional')}</span>
        <textarea name="reasoning" maxLength={rubric.reasoning.max_length} rows={4} dir="auto" required={required} />
        <small>{t('reviewPointsHelp')}</small>
      </label>
    </fieldset>
    {error && <p role="alert" className="error">{t(error)}</p>}
    <div><button disabled={busy}>{t('finishReview')}</button></div>
  </form>;
}

export function ReviewQueue({ signedIn }: { signedIn: boolean }) {
  const { t, l } = useLanguage();
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [active, setActive] = useState<string>();
  const [notice, setNotice] = useState<Message>();
  const [refreshing, setRefreshing] = useState(false);
  const { data, error } = useData<Page<Assignment>>(signedIn
    ? '/v1/me/reviews?offset=' + offset + '&revision=' + revision : '/session');

  async function refresh() {
    setRefreshing(true);
    setNotice(undefined);
    try {
      await request('/v1/me/reviews/refresh', 'POST', {});
      setOffset(0);
      setRevision(value => value + 1);
    } catch (cause) {
      setNotice(message(cause));
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    if (signedIn) void refresh();
  }, [signedIn]);

  return <section className="panel">
    <h1>{t('reviews')}</h1>
    {!signedIn ? <p><a href="/profile">{t('needAccount')}</a></p> : <>
      <p>{t('reviewQueueHelp')}</p>
      <button className="secondary" disabled={refreshing} onClick={() => void refresh()}>{t('refreshReviews')}</button>
      {notice && <p role="status">{t(notice)}</p>}
      {!data?.items ? <Feedback error={error} /> : <>
        {!data.items.length && <p>{t('noReviews')}</p>}
        <ul className="record-list">{data.items.map(item => <li key={item.id} className="review-card">
          <button className="secondary" aria-expanded={active === item.id} onClick={() => setActive(active === item.id ? undefined : item.id)}>
            {t(item.completed ? 'completedReview' : 'openReview')}
          </button>
          {item.feedback && <span className="status-chip">{l(rubricFor().options[item.feedback.assessment])}</span>}
          {item.repair.values.symptoms && <p className="record-preview" dir="auto" lang={item.repair.content_language}>{item.repair.values.symptoms}</p>}
          {active === item.id && <>
            <CaseFacts repair={item.repair} />
            {item.feedback && <ReviewFeedback entry={item.feedback} />}
            {!item.completed && <ReviewForm assignment={item} onComplete={() => {
              setActive(undefined);
              setNotice('reviewSaved');
              setRevision(value => value + 1);
            }} />}
          </>}
        </li>)}</ul>
        <Paging offset={offset} next={data.next_offset} change={setOffset} />
      </>}
    </>}
  </section>;
}

export function Activity() {
  const { locale, t } = useLanguage();
  const { data, error } = useData<{
    points: number; reputation: { peer_reviewed_repairs: number };
    history: { contribution: number; points: number; created_at: number; reversed: number }[];
  }>('/v1/me/activity');
  const number = new Intl.NumberFormat(locale);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  return <section className="account-actions activity">
    <h2>{t('activity')}</h2>
    <div className="actions"><a href="/cases">{t('reports')}</a><a href="/reviews">{t('reviews')}</a></div>
    {!data ? <Feedback error={error} /> : <>
      <dl className="case-facts">
        <div><dt>{t('points')}</dt><dd>{number.format(data.points)}</dd></div>
        <div><dt>{t('reputation')}</dt><dd>{number.format(data.reputation.peer_reviewed_repairs)}</dd></div>
      </dl>
      {data.history.length > 0 && <ul className="record-list">{data.history.map((entry, index) =>
        <li className="review-card" key={index}>
          {t(entry.contribution ? 'contributionAward' : 'reviewAward')} · {number.format(entry.points)} · {date.format(entry.created_at * 1000)}
          {Boolean(entry.reversed) && <span className="status-chip">{t('reversed')}</span>}
        </li>)}</ul>}
    </>}
  </section>;
}

export function Leaderboard() {
  const { t, locale } = useLanguage();
  const { data, error } = useData<{ items: { nickname: string; points: number }[] }>('/v1/leaderboard');
  const number = new Intl.NumberFormat(locale);
  return <section className="panel">
    <h1>{t('leaderboard')}</h1>
    <p>{t('rankingHelp')}</p>
    {!data ? <Feedback error={error} /> : !data.items.length ? <p>{t('noRanking')}</p> :
      <ol className="record-list ranking-list">{data.items.map((entry, index) =>
        <li className="review-card" key={index}>
          <bdi>{entry.nickname}</bdi><span>{number.format(entry.points)} {t('points')}</span>
        </li>)}</ol>}
  </section>;
}
