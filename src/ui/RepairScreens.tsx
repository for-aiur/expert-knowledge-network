import { Icon } from './Icon';
import { useEffect, useState, type FormEvent } from 'react';
import { rubricFor, rubricOptions, statuses, type Assignment, type FeedbackEntry, type Page, type Repair, type WorkflowType } from '../repair';
import { localeNames, isLocale } from '../i18n/messages';
import { workflowFor } from '../workflows';
import type { Message } from '../i18n/messages';
import { useLanguage } from './Language';
import { message, request } from './api';

type CaseView = Pick<Repair, 'content_language' | 'schema_version' | 'values'>;

function useData<T>(path: string) {
  const [state, setState] = useState<{ data?: T; error?: Message }>({});
  useEffect(() => {
    if (!path) return;
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

function CaseFacts({ repair, type = 'repair_case' }: { repair: CaseView; type?: WorkflowType }) {
  const { l, t } = useLanguage();
  const workflow = workflowFor(type, repair.schema_version);
  return <>
    <p className="note">{t(type === 'diagnosis_review' ? 'diagnosisNotice' : 'reported')}</p>
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

function ReviewFeedback({ entry, type = 'repair_case' }: { entry: FeedbackEntry; type?: WorkflowType }) {
  const { t, l } = useLanguage();
  const rubric = entry.rubric_version === null ? undefined : rubricFor(entry.rubric_version, type);
  return <div className="review-card">
    <strong>{l(rubricFor(undefined, type).options[entry.assessment])}</strong>
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
  const [safety, setSafety] = useState('');
  const rubric = rubricFor(assignment.rubric_version, assignment.workflow_type);
  const hasSteps = Boolean(assignment.repair.values.recommended_next_steps?.trim());
  if (!rubric) return <Feedback error="formMissing" />;
  const required = rubric.reasoning.required_for.includes(assessment) || safety === 'unsafe';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const reasoning = String(fields.get('reasoning') ?? '');
    const answers = Object.fromEntries(rubric.fields.map(field => [field.name, fields.get(field.name)]));
    if (safety === 'unsafe' && assessment === 'valid') {
      setError('unsafeAssessment');
      return;
    }
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
          if (field.name === 'next_step_safety') setSafety(event.target.value);
        }}>
          <option value="">{t('choose')}</option>
          {rubricOptions(field, assignment.repair.values.outcome?.trim()).filter(value =>
            field.name !== 'next_step_safety' || (hasSteps ? value !== 'not_applicable' : value === 'not_applicable')).map(value =>
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
          <p className="status-chip"><Icon name={item.workflow_type === 'diagnosis_review' ? 'problem' : 'equipment'} />
            {l(workflowFor(item.workflow_type, item.repair.schema_version).title)}</p>
          <button className="secondary" aria-expanded={active === item.id} onClick={() => setActive(active === item.id ? undefined : item.id)}>
            {t(item.completed ? 'completedReview' : 'openReview')}
          </button>
          {item.feedback && <span className="status-chip">{l(rubricFor(undefined, item.workflow_type).options[item.feedback.assessment])}</span>}
          {item.repair.values.symptoms && <p className="record-preview" dir="auto" lang={item.repair.content_language}>{item.repair.values.symptoms}</p>}
          {active === item.id && <>
            <CaseFacts repair={item.repair} type={item.workflow_type} />
            {item.feedback && <ReviewFeedback entry={item.feedback} type={item.workflow_type} />}
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
    metrics: { reports: number; peer_reviewed_repairs: number; completed_reviews: number; qualified_reviews: number; outstanding_reviews: number; clarifications: number };
    history: { contribution: number; points: number; created_at: number; reversed: number }[];
  }>('/v1/me/activity');
  const number = new Intl.NumberFormat(locale);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  return <section id="achievements" className="account-actions activity">
    <h2>{t('activity')}</h2>
    {!data ? <Feedback error={error} /> : <>
      <dl className="activity-stats">
        <div><dt>{t('reportsStat')}</dt><dd>{number.format(data.metrics.reports)}</dd></div>
        <div><dt>{t('peerReviewedStat')}</dt><dd>{number.format(data.reputation.peer_reviewed_repairs)}</dd></div>
        <div><dt>{t('completedReviews')}</dt><dd>{number.format(data.metrics.completed_reviews)}</dd></div>
        <div><dt>{t('points')}</dt><dd>{number.format(data.points)}</dd></div>
      </dl>
      <AchievementCollection metrics={data.metrics} full />
      {data.history.length > 0 && <ul className="record-list">{data.history.map((entry, index) =>
        <li className="review-card" key={index}>
          {t(entry.contribution ? 'contributionAward' : 'reviewAward')} · {number.format(entry.points)} · {date.format(entry.created_at * 1000)}
          {Boolean(entry.reversed) && <span className="status-chip">{t('reversed')}</span>}
        </li>)}</ul>}
    </>}
  </section>;
}

type ActivityData = {
  points: number;
  reputation: { peer_reviewed_repairs: number };
  metrics: { reports: number; peer_reviewed_repairs: number; completed_reviews: number; qualified_reviews: number; outstanding_reviews: number; clarifications: number };
  history: { contribution: number; points: number; created_at: number; reversed: number }[];
};

const achievements = [
  { id: 'firstContribution', icon: 'contribution', measure: 'peerReviewed' as const, target: 1 },
  { id: 'knowledgeBuilder', icon: 'equipment', measure: 'peerReviewed' as const, target: 5 },
  { id: 'trustedContributor', icon: 'achievement', measure: 'peerReviewed' as const, target: 20 },
  { id: 'expertReviewer', icon: 'reviewer', measure: 'reviews' as const, target: 10 },
  { id: 'dedicatedExpert', icon: 'progress', measure: 'reviews' as const, target: 50 },
] as const;

function AchievementCollection({ metrics, full = false }: { metrics: ActivityData['metrics']; full?: boolean }) {
  const { t, locale } = useLanguage();
  const number = new Intl.NumberFormat(locale);
  const collection = achievements.map(item => ({ ...item,
    value: item.measure === 'peerReviewed' ? metrics.peer_reviewed_repairs : metrics.qualified_reviews,
  }));
  const visible = full ? collection : collection.filter(item => item.value >= item.target).slice(0, 2)
    .concat(collection.filter(item => item.value < item.target).slice(0, 1));
  return <section className={'achievement-section' + (full ? ' achievement-full' : '')} aria-labelledby="achievement-heading">
    <div className="section-heading">
      <div><p className="eyebrow">{t('nextMilestone')}</p><h2 id="achievement-heading">{t('achievements')}</h2></div>
      {!full && <a href="/profile#achievements">{t('viewAll')}</a>}
    </div>
    {!full && collection.every(item => item.value === 0) && <p className="achievement-intro">{t('emptyAchievement')}</p>}
    <ul className="achievement-list">
      {visible.map(item => {
        const unlocked = item.value >= item.target;
        const IconName = item.icon;
        return <li className="achievement-item" data-earned={unlocked} key={item.id}>
          <span className="achievement-icon"><Icon name={IconName} /></span>
          <span className="achievement-copy"><strong>{t(item.id as Message)}</strong>
            <small>{t((item.id + 'Desc') as Message)}</small></span>
          <span className="achievement-state">{unlocked ? t('earned') : `${number.format(Math.min(item.value, item.target))} / ${number.format(item.target)}`}</span>
          {!unlocked && <progress max={item.target} value={Math.min(item.value, item.target)} aria-label={`${t('progress')}: ${t(item.id as Message)}`} />}
        </li>;
      })}
    </ul>
    <p className="recognition-note">{t('recognitionNote')}</p>
  </section>;
}

export function Home({ signedIn, nickname, userId }: { signedIn: boolean; nickname?: string; userId?: string }) {
  const { t, locale } = useLanguage();
  const { data, error } = useData<ActivityData>(signedIn ? '/v1/me/activity' : '');
  const [toast, setToast] = useState('');
  const number = new Intl.NumberFormat(locale);
  useEffect(() => {
    if (!data || !userId) return;
    const current = achievements.filter(item =>
      (item.measure === 'peerReviewed' ? data.metrics.peer_reviewed_repairs : data.metrics.qualified_reviews) >= item.target
    ).map(item => item.id);
    try {
      const key = `ekn-earned-milestones:${userId}`;
      const prior = localStorage.getItem(key);
      localStorage.setItem(key, JSON.stringify(current));
      if (prior === null) return;
      const known = JSON.parse(prior) as unknown;
      if (!Array.isArray(known)) return;
      const unlocked = current.find(id => !known.includes(id));
      if (unlocked) {
        setToast(`${t('achievementUnlocked')}: ${t(unlocked as Message)}`);
        const timer = window.setTimeout(() => setToast(''), 5000);
        return () => window.clearTimeout(timer);
      }
    } catch {
      // Achievement status remains visible in the collection if storage is disabled.
    }
  }, [data, t, userId]);
  if (!signedIn) return <section className="hero">
    <div className="hero-body">
      <p className="eyebrow">{t('communityCases')}</p><h1>{t('hero')}</h1><p>{t('intro')}</p>
      <div className="actions"><a className="button" href="/profile">{t('join')}</a>
        <a className="button secondary" href="/community">{t('communityCases')}</a></div>
    </div><div className="hero-mark" aria-hidden="true"><Icon name="mark" /></div>
  </section>;
  return <section className="dashboard">
    {toast && <p className="achievement-toast" role="status"><Icon name="achievement" />{toast}</p>}
    <header className="dashboard-heading">
      <div><p className="eyebrow">{t('dashboard')}</p><h1><bdi>{nickname}</bdi></h1><p>{t('dashboardIntro')}</p></div>
    </header>
    {data && data.metrics.clarifications > 0 && <a className="attention-banner" href="/cases?status=needs_clarification">
      <Icon name="problem" /><span><strong>{number.format(data.metrics.clarifications)} · {t('needs_clarification')}</strong><small>{t('attention')}</small></span><Icon name="next" />
    </a>}
    <div className="dashboard-actions">
      <a className="action-tile action-primary" href="/submit"><span className="tile-icon"><Icon name="submit" /></span><span><strong>{t('shareRepair')}</strong><small>{t('shareRepairHelp')}</small></span><Icon name="next" /></a>
      <a className="action-tile" href="/reviews"><span className="tile-icon tile-blue"><Icon name="reviews" /></span><span><strong>{t('openQueue')}</strong><small>{t('openQueueHelp')}</small></span>{data && data.metrics.outstanding_reviews > 0 && <b className="task-count">{number.format(data.metrics.outstanding_reviews)}</b>}</a>
      <a className="action-tile" href="/cases"><span className="tile-icon tile-copper"><Icon name="reports" /></span><span><strong>{t('reports')}</strong><small>{t('myReportsHelp')}</small></span><Icon name="next" /></a>
    </div>
    {!data ? <Feedback error={error} /> : <>
      <section className="dashboard-stats" aria-label={t('activity')}>
        <article><span className="stat-mark"><Icon name="reports" /></span><div><strong>{number.format(data.metrics.reports)}</strong><small>{t('reportsStat')}</small></div></article>
        <article><span className="stat-mark stat-green"><Icon name="done" /></span><div><strong>{number.format(data.reputation.peer_reviewed_repairs)}</strong><small>{t('peerReviewedStat')}</small></div></article>
        <article><span className="stat-mark stat-blue"><Icon name="reviewer" /></span><div><strong>{number.format(data.metrics.completed_reviews)}</strong><small>{t('completedReviews')}</small></div></article>
        <article><span className="stat-mark stat-gold"><Icon name="achievement" /></span><div><strong>{number.format(data.points)}</strong><small>{t('points')}</small></div></article>
      </section>
      <div className="dashboard-lower">
        <AchievementCollection metrics={data.metrics} />
        <aside className="dashboard-note"><p className="eyebrow">{t('profile')}</p><strong>{t('expertise')}</strong>
          <p>{t('expertiseHelp')}</p><a href="/profile">{t('profile')}</a>
        </aside>
      </div>
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
