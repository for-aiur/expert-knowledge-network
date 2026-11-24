import { Icon } from './Icon';
import { EquipmentInput } from './EquipmentInput';
import { useEffect, useState, type FormEvent } from 'react';
import { fieldLimit, fieldRequired, validateFields, type Field, type Workflow } from '../workflows';
import { message, request } from './api';
import { useLanguage } from './Language';
import { localeNames } from '../i18n/messages';
import type { Repair } from '../repair';
import type { Message } from '../i18n/messages';

const steps = [
  { name: 'equipment', title: 'equipmentStep', fields: ['equipment_category', 'manufacturer', 'model', 'fault_code'] },
  { name: 'problem', title: 'problemStep', fields: ['symptoms', 'diagnostic_steps', 'root_cause'] },
  { name: 'outcome', title: 'outcomeStep', fields: ['outcome', 'resolution', 'source_type', 'sharing_permission'] },
] as const;

function fieldStep(name: string) {
  const index = steps.findIndex(step => step.fields.some(field => field === name));
  return index === -1 ? steps.length - 1 : index;
}

const disclosed = new Set(['fault_code', 'diagnostic_steps', 'root_cause']);

export function WorkflowForm({ workflow, signedIn, draft }: { workflow: Workflow; signedIn: boolean; draft?: Repair }) {
  const { locale, t, l } = useLanguage();
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...draft?.values, sharing_permission: draft?.values.sharing_permission === 'community' ? 'community' : 'private' }));
  const [step, setStep] = useState(0);
  const [attempted, setAttempted] = useState<number[]>([]);
  const [focus, setFocus] = useState<{ id: string }>();
  const [consentError, setConsentError] = useState(false);
  const [serverIssue, setServerIssue] = useState<Message>();
  const [busy, setBusy] = useState(false);
  const [id] = useState(() => draft?.id ?? crypto.randomUUID());
  const [language, setLanguage] = useState(draft?.content_language ?? locale);
  const [consent, setConsent] = useState(draft?.review_consent ?? false);
  const [saved, setSaved] = useState(false);
  const [remoteErrors, setRemoteErrors] = useState<Record<string, string>>({});
  const validation = validateFields(workflow, values, locale).errors;
  const errors = {
    ...Object.fromEntries(Object.entries(validation).filter(([key]) => attempted.includes(fieldStep(key)))),
    ...remoteErrors,
  };

  useEffect(() => {
    if (!focus) return;
    const element = document.getElementById(focus.id);
    const details = element?.closest('details');
    if (details) details.open = true;
    element?.focus();
  }, [focus]);

  function move(index: number, id = 'repair-step-heading') {
    setStep(index);
    setFocus({ id });
  }

  function showErrors(issues: Record<string, string>) {
    setRemoteErrors(issues);
    const first = workflow.fields.find(field => issues[field.name]);
    if (first) move(fieldStep(first.name), first.name);
  }

  async function persist(submit: boolean) {
    setServerIssue(undefined);
    setSaved(false);
    setRemoteErrors({});
    setConsentError(false);
    if (submit) {
      const first = workflow.fields.find(field => validation[field.name]);
      if (first || !consent) {
        setAttempted([0, 1, 2]);
        if (first) move(fieldStep(first.name), first.name);
        else {
          setConsentError(true);
          move(2, 'review-consent');
        }
        return;
      }
    }
    setBusy(true);
    try {
      const path = '/v1/me/submissions/' + id;
      const result = await request<Repair & { errors?: Record<string, string> }>(path, 'PUT', {
        values, content_language: language, review_consent: consent, schema_version: workflow.version,
      }, locale, true);
      if (result.errors) {
        showErrors(result.errors);
        return;
      }
      if (submit) {
        const submitted = await request<Repair & { errors?: Record<string, string> }>(path + '/submit', 'POST', {}, locale, true);
        if (submitted.errors) {
          showErrors(submitted.errors);
          return;
        }
        window.location.assign('/cases/' + id);
      } else {
        window.history.replaceState(null, '', '/submit?draft=' + id);
        setSaved(true);
      }
    } catch (cause) {
      setServerIssue(message(cause));
    } finally {
      setBusy(false);
    }
  }

  function advance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (step === steps.length - 1) {
      if (signedIn) void persist(true);
      return;
    }
    const first = workflow.fields.find(field => fieldStep(field.name) === step && validation[field.name]);
    if (first) {
      setAttempted(current => current.includes(step) ? current : [...current, step]);
      move(step, first.name);
    } else move(step + 1);
  }

  function renderField(field: Field) {
    const required = fieldRequired(field, values);
    const issue = errors[field.name];
    const descriptionId = field.description ? field.name + '-description' : '';
    const issueId = issue ? field.name + '-error' : '';
    function update(value: string) {
      setValues(current => ({ ...current, [field.name]: value }));
      setServerIssue(undefined);
      setSaved(false);
      setRemoteErrors({});
    }
    const props = {
      id: field.name, name: field.name, value: values[field.name] ?? '', required,
      'aria-invalid': issue ? true : undefined,
      'aria-describedby': [descriptionId, issueId].filter(Boolean).join(' ') || undefined,
      onChange(event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) {
        update(event.target.value);
      },
    };
    const code = field.name === 'fault_code' || field.name === 'model';
    const equipment = field.type === 'text' && (field.name === 'manufacturer' || field.name === 'model')
      ? field.name : null;
    return <div key={field.name} className={field.type === 'text' ? 'compact-field' : 'full-field'}>
      <label className="field-label" id={field.name + '-label'} htmlFor={field.name}>{l(field.label)}
        <span className="field-status">{t(required ? 'required' : 'optional')}</span></label>
      {field.name === 'symptoms' && <span className="coming-soon" aria-disabled="true">
        <Icon name="dictate" />{t('dictate')}<span aria-hidden="true">·</span>{t('comingSoon')}
      </span>}
      {field.description && <small id={descriptionId}>{l(field.description)}</small>}
      {field.type === 'select' ? <select {...props}>
        <option value="">{t('choose')}</option>
        {field.options?.map(option => <option key={option.value} value={option.value}>{l(option.label)}</option>)}
      </select> : field.type === 'textarea' ? <textarea {...props} dir="auto" maxLength={fieldLimit(field)} rows={3} />
        : equipment ? <EquipmentInput {...props} id={equipment} onValue={update}
          manufacturer={values.manufacturer ?? ''} category={values.equipment_category ?? ''} maxLength={fieldLimit(field)} />
        : <input {...props} type="text" dir={code ? 'ltr' : 'auto'} maxLength={fieldLimit(field)}
          autoCapitalize={code ? 'none' : undefined} spellCheck={code ? false : undefined} />}
      {issue && <small className="error" id={issueId}>{issue}</small>}
    </div>;
  }

  const current = steps[step];
  const fields = workflow.fields.filter(field => fieldStep(field.name) === step);
  const optional = fields.filter(field => disclosed.has(field.name) && !fieldRequired(field, values));
  const sharing = fields.find(field => field.name === 'sharing_permission');
  const main = fields.filter(field => field !== sharing && !optional.includes(field) &&
    (field.name !== 'resolution' || fieldRequired(field, values) || !!values.resolution || !!errors.resolution));
  const hasIssues = fields.some(field => errors[field.name]);

  return <form className="stack repair-wizard" onSubmit={advance} noValidate>
    <ol className="repair-progress" aria-label={t('repairProgress')}>
      {steps.map((item, index) => <li key={item.name} aria-current={step === index ? 'step' : undefined}
        data-complete={index < step}>
        <Icon name={index < step ? 'done' : item.name} /><span>{t(item.title)}</span>
      </li>)}
    </ol>
    <progress className="repair-progress-bar" value={step + 1} max={steps.length} aria-label={t('repairProgress')} />
    <section className="repair-step" aria-labelledby="repair-step-heading">
      <h2 id="repair-step-heading" tabIndex={-1}>{t(current.title)}</h2>
      {step === 1 && <p className="note">{t('synthetic')}</p>}
      {(hasIssues || Boolean(errors.form)) && <p className="error" role="alert">{errors.form ?? t('highlight')}</p>}
      <fieldset disabled={busy} className="workflow-fields">
        {main.map(renderField)}
        {!!optional.length && <details key={step} className="repair-details full-field" open={optional.some(field => !!errors[field.name]) || undefined}>
          <summary>{t('optionalDetails')}</summary>
          <div className="stack">{optional.map(renderField)}</div>
        </details>}
      </fieldset>
      {step === 2 && <fieldset className="stack" disabled={busy}>
        <label>{t('contentLanguage')}<select value={language} onChange={event => {
          setLanguage(event.target.value);
          setSaved(false);
        }}>
          {!Object.hasOwn(localeNames, language) && <option value={language}>{language}</option>}
          {Object.entries(localeNames).map(([code, name]) => <option key={code} value={code} lang={code}>{name}</option>)}
        </select></label>
      </fieldset>}
      {step === 2 && <fieldset className="stack permission-panel" disabled={busy}>
        <legend>{t('permissions')}</legend>
        {signedIn && <label className="choice"><input id="review-consent" type="checkbox" checked={consent}
          aria-invalid={consentError || undefined} aria-describedby={consentError ? 'review-consent-error' : undefined}
          onChange={event => {
            setConsent(event.target.checked);
            setConsentError(false);
            setSaved(false);
          }} />{t('reviewConsent')}</label>}
        {sharing && <label className="choice"><input id="sharing_permission" type="checkbox"
          checked={values.sharing_permission === 'community'} onChange={event => {
            const permission = event.target.checked ? 'community' : 'private';
            setValues(current => ({ ...current, sharing_permission: permission }));
            setSaved(false);
            setRemoteErrors({});
          }} />
          <span>{t('shareOptIn')}{sharing.description && <small>{l(sharing.description)}</small>}</span>
        </label>}
        {consentError && <small id="review-consent-error" className="error" role="alert">{t('consentNeeded')}</small>}
      </fieldset>}
    </section>
    {serverIssue && <p className="error" role="alert">{t(serverIssue)}</p>}
    {saved && <p className="notice" role="status"><Icon name="done" />{t('draftSaved')}</p>}
    <div className="actions repair-actions">
      {step > 0 && <button type="button" className="secondary" disabled={busy} onClick={() => move(step - 1)}>
        <Icon name="back" />{t('backStep')}</button>}
      {signedIn && <button type="button" className="secondary" disabled={busy} onClick={() => void persist(false)}>
        <Icon name="save" />{t('saveDraft')}</button>}
      {step < steps.length - 1 ? <button data-action="next-step" disabled={busy}>{t('continue')}<Icon name="next" /></button>
        : signedIn ? <button disabled={busy}><Icon name="submit" />{t('submitReview')}</button>
          : <a className="button" href="/profile">{t('needAccount')}</a>}
    </div>
  </form>;
}
