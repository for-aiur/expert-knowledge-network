import { useEffect, useState, type FormEvent } from 'react';
import { useLanguage } from './Language';
import { Icon } from './Icon';
import { message, request } from './api';
import type { Message } from '../i18n/messages';
import { categories } from '../workflows';

type Item = { id: string; workflow_type: string; schema_version: number; equipment_category: string;
  source_type: string; sharing_permission: string; status: string; created_at: number; assigned: number; completed: number; summary: Record<string, unknown> };
type Detail = Item & { payload: Record<string, unknown>; reviews: Array<{ reviewer: string; overall_assessment: string | null;
  rubric_version: number | null; purpose: string; answers: Record<string, unknown> | null; created_at: number }>;
  permissions: { review_consent: boolean; community_sharing: boolean } };
type AdminPage = { items: Item[]; total: number; next_offset: number | null };
type Summary = Record<string, number>;

export function AdminExplorer() {
  const { t, l } = useLanguage();
  const [summary, setSummary] = useState<Summary>();
  const [page, setPage] = useState<AdminPage>();
  const [detail, setDetail] = useState<Detail>();
  const [error, setError] = useState<Message>();
  const [filters, setFilters] = useState({ type: '', status: '', category: '', from: '', to: '' });
  const [query, setQuery] = useState('');

  async function load(nextOffset = 0, nextQuery = query) {
    setError(undefined);
    try {
      const [overview, records] = await Promise.all([
        request<{ data?: Summary } & Summary>('/v1/admin/overview'),
        request<AdminPage>('/v1/admin/submissions?' + (nextQuery ? nextQuery + '&' : '') + 'limit=20&offset=' + nextOffset),
      ]);
      setSummary(overview.data ?? overview);
      setPage(records);
    } catch (cause) { setError(message(cause)); }
  }
  useEffect(() => { void load(); }, []);

  async function apply(event: FormEvent) {
    event.preventDefault();
    const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
    setQuery(params.toString());
    await load(0, params.toString());
    setDetail(undefined);
  }

  async function open(item: Item) {
    setError(undefined);
    try { setDetail(await request<Detail>('/v1/admin/submissions/' + encodeURIComponent(item.id))); }
    catch (cause) { setError(message(cause)); }
  }

  async function exportData(format: 'json' | 'csv', scope: 'community' | 'internal') {
    const params = new URLSearchParams(query);
    params.set('format', format);
    if (scope === 'internal') params.set('scope', scope);
    const response = await fetch('/api/v1/admin/export?' + params.toString());
    if (!response.ok) { setError('adminForbidden'); return; }
    const blob = await response.blob();
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = format === 'csv' ? 'ekn-repairs.csv' : 'ekn-repairs.json';
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  const statusOptions = ['draft','pending','in_review','peer_reviewed','disputed','rejected','needs_clarification','queued','completed','cancelled'];
  const labelKey = (value: string): Message => ['firsthand','observed','secondhand','external','private','community'].includes(value) ? value as Message : 'external';
  return <section className="admin-screen">
    <div className="admin-heading"><span className="identity-icon"><Icon name="profile" /></span><div><h1>{t('adminTitle')}</h1><p>{t('overview')}</p></div></div>
    {error && <p className="error" role="alert">{t(error)}</p>}
    {summary && <div className="admin-stats" aria-label={t('overview')}>
      {[['repair_count','repairCount'],['diagnosis_count','diagnosisCount'],['peer_reviewed_count','peerReviewedCount'],
        ['open_repair_count','openCases'],['open_diagnosis_count','openDiagnosis']].map(([key,label]) =>
        <article className="admin-stat" key={key}><small>{t(label as Message)}</small><strong>{summary[key]}</strong></article>)}
    </div>}
    <section className="panel admin-panel">
      <div className="admin-toolbar"><h2>{t('filters')}</h2>
        <div className="actions">
          <button type="button" className="secondary" onClick={() => void exportData('json','community')}>{t('exportJson')}</button>
          <button type="button" className="secondary" onClick={() => void exportData('csv','community')}>{t('exportCsv')}</button>
        </div>
      </div>
      <p className="note">{t('exportWarning')}</p>
      <form className="admin-filters" onSubmit={apply}>
        <label>{t('type')}<select value={filters.type} onChange={e=>setFilters({...filters,type:e.target.value})}>
          <option value="">{t('allReports')}</option><option value="repair_case">{t('repairCount')}</option><option value="diagnosis_review">{t('diagnosisCount')}</option>
        </select></label>
        <label>{t('status')}<select value={filters.status} onChange={e=>setFilters({...filters,status:e.target.value})}>
          <option value="">{t('allReports')}</option>{statusOptions.map(value=><option key={value} value={value}>{t(value as Message)}</option>)}
        </select></label>
        <label>{t('category')}<select value={filters.category} onChange={e=>setFilters({...filters,category:e.target.value})}>
          <option value="">{t('allReports')}</option>{categories.map(item=><option key={item.value} value={item.value}>{l(item.label)}</option>)}
        </select></label>
        <label>{t('from')}<input type="date" value={filters.from} onChange={e=>setFilters({...filters,from:e.target.value})}/></label>
        <label>{t('to')}<input type="date" value={filters.to} onChange={e=>setFilters({...filters,to:e.target.value})}/></label>
        <button>{t('apply')}</button>
      </form>
      {page && <p className="admin-total">{t('total')}: {page.total}</p>}
      <div className="admin-records">
        {page?.items.map(item=><button key={item.id} className="admin-record" type="button" onClick={()=>void open(item)}>
          <span><strong>{[item.summary.manufacturer,item.summary.model,item.summary.fault_code].filter(Boolean).join(' · ') ||
              l(categories.find(category=>category.value===item.equipment_category)?.label ?? {en:item.equipment_category})}</strong>
            <small>{item.workflow_type === 'repair_case' ? t('repairCount') : t('diagnosisCount')} · {t(item.status as Message)} ·
              {' '}{t(labelKey(item.source_type))} · v{item.schema_version} · {t(item.sharing_permission === 'community' ? 'communitySharing' : 'sharingPrivate')}</small></span>
          <span className="admin-record-meta">{item.completed}/{item.assigned} {t('reviewCount')} · {new Date(item.created_at * 1000).toLocaleDateString()}</span>
        </button>)}
      </div>
      {page?.next_offset !== null && page?.next_offset !== undefined && <button className="secondary" onClick={()=>void load(page.next_offset!)}>{t('loadMore')}</button>}
      {detail && <section className="admin-detail" aria-live="polite">
        <h2>{t('details')}</h2><dl className="admin-detail-grid">
          <div><dt>ID</dt><dd><bdi>{detail.id}</bdi></dd></div><div><dt>{t('type')}</dt><dd>{detail.workflow_type}</dd></div>
          <div><dt>{t('schemaVersion')}</dt><dd>{detail.schema_version}</dd></div><div><dt>{t('status')}</dt><dd>{t(detail.status as Message)}</dd></div>
          <div><dt>{t('sourceType')}</dt><dd>{t(labelKey(detail.source_type ?? 'external'))}</dd></div>
          <div><dt>{t('permission')}</dt><dd>{detail.permissions.review_consent ? t('reviewAllowed') : '—'} · {detail.permissions.community_sharing ? t('communitySharing') : t('sharingPrivate')}</dd></div>
        </dl>
        <pre className="admin-payload">{JSON.stringify(detail.payload,null,2)}</pre>
        <h3>{t('reviews')} · {detail.reviews.length}</h3>
        {detail.reviews.map((review,index)=><article className="admin-review" key={index}>
          <strong>{review.reviewer}</strong> · {review.overall_assessment ?? t('pending')}<small>{t('reasoning')}</small>
          <pre>{JSON.stringify(review.answers,null,2)}</pre>
        </article>)}
      </section>}
    </section>
  </section>;
}
